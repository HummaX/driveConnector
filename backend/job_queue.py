"""Durable media queue. Expired owners are stalled, NEVER automatically reclaimed.

One document per (video, kind) allows multiple pending operations. The unique
partial index installed by init_indexes is the final cross-process exclusion
boundary, including stalled owners whose subprocesses may still be alive.
"""
import hashlib
import os
import uuid
from datetime import datetime, timedelta

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError
from database import get_db

JOB_TYPES = {"download_drive", "download_url", "process", "transcode", "transcribe"}
ACTIVE_STATES = ["queued", "running", "stalled"]


class QueueFull(RuntimeError):
    pass


def capacity():
    return max(1, min(10000, int(os.environ.get("MEDIA_QUEUE_MAX_PENDING", "100"))))


def slots():
    return get_db()["media_job_slots"]


async def _reserve_slot():
    token = uuid.uuid4().hex
    slot = await slots().find_one_and_update(
        {"_id": {"$gte": 0, "$lt": capacity()}, "token": None},
        {"$set": {"token": token, "reserved_at": datetime.utcnow()}},
        sort=[("_id", 1)], return_document=ReturnDocument.AFTER)
    if slot is None:
        raise QueueFull("Media queue capacity reached (or admission needs operator reconciliation)")
    return {"admission_slot": slot["_id"], "admission_token": token}


async def _release_slot(job):
    if job.get("admission_token"):
        await slots().update_one(
            {"_id": job["admission_slot"], "token": job["admission_token"]},
            {"$set": {"token": None}, "$unset": {"reserved_at": ""}})


async def init_queue():
    await init_indexes()
    limit = capacity()
    policy = await slots().find_one_and_update(
        {"_id": "capacity"}, {"$setOnInsert": {"value": limit}},
        upsert=True, return_document=ReturnDocument.AFTER)
    if policy["value"] != limit:
        raise RuntimeError("MEDIA_QUEUE_MAX_PENDING changed; inspect queue slots before explicit migration")
    if await collection().count_documents(
            {"state": {"$in": ACTIVE_STATES}, "admission_token": {"$exists": False}}, limit=1):
        raise RuntimeError("Legacy active media jobs require explicit operator migration before startup")
    for index in range(limit):
        await slots().update_one({"_id": index}, {"$setOnInsert": {"token": None}}, upsert=True)



def collection():
    return get_db()["media_jobs"]


def _job_id(video_id, kind):
    return hashlib.sha256((video_id + "\0" + kind).encode()).hexdigest()


async def init_indexes():
    # Do not drop/rewrite old queue data. Index creation must fail startup if
    # existing data would permit overlapping owners.
    await collection().create_index(
        "video_id", name="one_media_owner_per_video", unique=True,
        partialFilterExpression={"state": {"$in": ["running", "stalled"]}})
    await collection().create_index([("state", 1), ("created_at", 1)])
    await collection().create_index([("video_id", 1), ("kind", 1)], unique=True)


async def enqueue_job(video_id, kind, payload=None, max_attempts=3):
    """Return False on duplicate same-kind pending/owned work.

    Payloads must not contain credentials. Distinct kinds can wait together;
    claim_job serializes execution, even against a stalled owner.
    """
    if not isinstance(video_id, str) or not video_id or kind not in JOB_TYPES:
        raise ValueError("Invalid video or media job type")
    if type(max_attempts) is not int or not 1 <= max_attempts <= 10:
        raise ValueError("Invalid max_attempts")
    if await collection().find_one({"video_id": video_id, "kind": kind, "state": {"$in": ACTIVE_STATES}}):
        return False
    reservation = await _reserve_slot()
    now = datetime.utcnow()
    doc = {"_id": _job_id(video_id, kind), "video_id": video_id, "kind": kind,
           "payload": dict(payload or {}), "state": "queued", "attempts": 0,
           "max_attempts": max_attempts, "created_at": now, "updated_at": now}
    doc.update(reservation)
    try:
        result = await collection().replace_one(
            {"_id": doc["_id"], "state": {"$in": ["done", "failed"]}}, doc, upsert=True)
        inserted = bool(result.modified_count or result.upserted_id is not None)
        if not inserted:
            await _release_slot(reservation)
        return inserted
    except DuplicateKeyError:
        await _release_slot(reservation)
        return False
    # Other database errors have ambiguous commit status. Keep the slot reserved
    # rather than silently exceed capacity. Operator reconciliation is explicit.


async def stall_expired_jobs():
    now = datetime.utcnow()
    # Retain token, worker ID, lease and process identity for operator recovery.
    return await collection().update_many(
        {"state": "running", "lease_until": {"$lte": now}},
        {"$set": {"state": "stalled", "updated_at": now,
                  "error": "Worker lease expired; verify all job processes stopped before recovery"}})


async def claim_job(worker_id, lease_seconds=120):
    if not worker_id or lease_seconds <= 0:
        raise ValueError("Invalid worker or lease")
    await stall_expired_jobs()
    blocked = await collection().distinct("video_id", {"state": {"$in": ["running", "stalled"]}})
    now = datetime.utcnow()
    try:
        return await collection().find_one_and_update(
            {"state": "queued", "video_id": {"$nin": blocked},
             "$expr": {"$lt": ["$attempts", "$max_attempts"]}},
            {"$set": {"state": "running", "worker_id": worker_id,
                      "claim_token": uuid.uuid4().hex,
                      "lease_until": now + timedelta(seconds=lease_seconds), "updated_at": now},
             "$inc": {"attempts": 1}}, sort=[("created_at", 1)], return_document=ReturnDocument.AFTER)
    except DuplicateKeyError:
        # Another worker claimed a different kind for this video first. The
        # unique ownership index wins; retry polling, not unsafe local execution.
        return None


def _owner_query(job):
    return {"_id": job["_id"], "state": "running", "claim_token": job["claim_token"],
            "lease_until": {"$gt": datetime.utcnow()}}


async def heartbeat(job, lease_seconds=120):
    now = datetime.utcnow()
    result = await collection().update_one(
        _owner_query(job),
        {"$set": {"lease_until": now + timedelta(seconds=lease_seconds), "updated_at": now}})
    return bool(result.modified_count)


async def record_process(job, pid):
    """Persist process-group identity before the child receives permission to run."""
    result = await collection().update_one(
        _owner_query(job), {"$set": {"process_group_id": pid, "updated_at": datetime.utcnow()}})
    return bool(result.modified_count)


async def stall_job(job, error):
    result = await collection().update_one(
        {"_id": job["_id"], "state": "running", "claim_token": job["claim_token"]},
        {"$set": {"state": "stalled", "updated_at": datetime.utcnow(), "error": str(error)[:500]}})
    return bool(result.modified_count)


async def finish_job(job, error=None, *, process_stopped=False):
    """Release a claim only after its isolated process tree is verified stopped.

    Completion is lease/token fenced. Lost leases stay stalled even if this
    supervisor subsequently reaped its child; operator verification is required.
    """
    if not process_stopped:
        raise ValueError("Refusing to release job without verified process shutdown")
    state = "done" if error is None else ("queued" if job["attempts"] < job["max_attempts"] else "failed")
    result = await collection().update_one(
        _owner_query(job),
        {"$set": {"state": state, "updated_at": datetime.utcnow(), "error": str(error)[:500] if error else None},
         "$unset": {"lease_until": "", "claim_token": "", "worker_id": "", "process_group_id": ""}})
    if result.modified_count and state in ("done", "failed"):
        await _release_slot(job)
    return bool(result.modified_count)


async def acquire_maintenance(video_id):
    """Claim deletion/reset exclusion under the same unique ownership index.

    A competing running worker wins or loses atomically against this claim.
    Queued jobs cannot start until maintenance has released ownership.
    """
    if await has_active_job(video_id):
        return None
    reservation = await _reserve_slot()
    now = datetime.utcnow()
    job = {"_id": _job_id(video_id, "maintenance"), "video_id": video_id,
           "kind": "maintenance", "state": "running", "attempts": 1,
           "max_attempts": 1, "claim_token": uuid.uuid4().hex,
           "worker_id": "api-maintenance", "lease_until": now + timedelta(minutes=10),
           "created_at": now, "updated_at": now, **reservation}
    try:
        result = await collection().replace_one(
            {"_id": job["_id"], "state": {"$in": ["done", "failed"]}}, job, upsert=True)
        if result.modified_count or result.upserted_id is not None:
            return job
        await _release_slot(reservation)
    except DuplicateKeyError:
        await _release_slot(reservation)
    return None


async def has_active_job(video_id):
    return bool(await collection().find_one({"video_id": video_id, "state": {"$in": ACTIVE_STATES}}, {"_id": 1}))


async def retry_job(video_id):
    """Reset one failed job; never reset running, queued or stalled ownership."""
    if not await collection().find_one({"video_id": video_id, "state": "failed", "kind": {"$in": list(JOB_TYPES)}}):
        return False
    reservation = await _reserve_slot()
    result = await collection().find_one_and_update(
        {"video_id": video_id, "state": "failed", "kind": {"$in": list(JOB_TYPES)}},
        {"$set": {"state": "queued", "attempts": 0, "updated_at": datetime.utcnow(),
                  "error": None, **reservation}},
        sort=[("updated_at", 1)], return_document=ReturnDocument.AFTER)
    if result is None:
        await _release_slot(reservation)
    return result is not None


async def recover_stalled(video_id, claim_token, *, verified_stopped=False):
    """Operator-only recovery, after independently verifying ALL work stopped.

    Verify the recorded host/process group (including surviving threads and
    external tools). A stale token cannot release a newer owner. No HTTP route
    should infer verified_stopped from a timeout or a browser-supplied boolean.
    """
    if verified_stopped is not True:
        raise ValueError("Operator must verify the old process tree has stopped")
    job = await collection().find_one({"video_id": video_id, "state": "stalled", "claim_token": claim_token})
    if job is None:
        return False
    result = await collection().update_one(
        {"_id": job["_id"], "state": "stalled", "claim_token": claim_token},
        {"$set": {"state": "failed", "updated_at": datetime.utcnow(),
                  "error": "Operator verified stopped; explicit retry permitted"},
         "$unset": {"lease_until": "", "claim_token": "", "worker_id": "", "process_group_id": ""}})
    if result.modified_count:
        await _release_slot(job)
    return bool(result.modified_count)


async def list_jobs(limit=100):
    """Bounded public status; intentionally omits payloads and ownership tokens."""
    projection = {"_id": 0, "video_id": 1, "kind": 1, "state": 1, "attempts": 1,
                  "max_attempts": 1, "created_at": 1, "updated_at": 1, "error": 1}
    return await collection().find({}, projection).sort("updated_at", -1).to_list(length=max(1, min(1000, int(limit))))


async def worker_seen(worker_id):
    await get_db()["media_workers"].update_one(
        {"_id": worker_id}, {"$set": {"last_seen": datetime.utcnow()}}, upsert=True)


async def worker_status():
    """No credentials or host details; readiness uses recent worker heartbeats."""
    cutoff = datetime.utcnow() - timedelta(seconds=90)
    recent = await get_db()["media_workers"].count_documents({"last_seen": {"$gte": cutoff}})
    return {"ready": recent > 0, "active_workers": recent}
