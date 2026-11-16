"""Durable latest-per-video telemetry shared by workers and the web process.

Each snapshot retains the latest payload of each event type. Global revisions
let a web poller deliver only changed events, in publication order. Payloads are
not embellished; `_revision` and `_updated_at` live alongside them in snapshots.
"""
from datetime import datetime
from database import get_db


def collection():
    return get_db()["media_job_events"]


async def init_indexes():
    await collection().create_index("updated_at")


async def publish(payload):
    """Persist a legacy event payload. Return its strictly increasing revision.

    One video document is the atomic publication boundary. A global counter is
    advanced first: gaps are harmless. Pollers must not assume a global cursor
    orders concurrently committed writes; compare each event's own revision.
    """
    from pymongo import ReturnDocument
    video_id, event = payload.get("video_id"), payload.get("event")
    if not isinstance(video_id, str) or not video_id or not isinstance(event, str) or not event or "." in event or "$" in event:
        raise ValueError("Invalid media event identity")
    counter = await get_db()["media_event_counters"].find_one_and_update(
        {"_id": "revision"}, {"$inc": {"value": 1}}, upsert=True, return_document=ReturnDocument.AFTER)
    revision, now = counter["value"], datetime.utcnow()
    # Atomic pipeline prevents a delayed older publisher from replacing a newer
    # payload of the same event type. MongoDB 4.2+; deployment uses MongoDB 7.
    field = "events." + event
    old_revision = {"$ifNull": ["$" + field + "._revision", 0]}
    newer = {"$gt": [revision, old_revision]}
    record = {**payload, "_revision": revision, "_updated_at": now}
    await collection().update_one({"_id": video_id}, [{"$set": {
        "video_id": {"$literal": video_id},
        "revision": {"$max": [{"$ifNull": ["$revision", 0]}, revision]},
        "updated_at": {"$max": [{"$ifNull": ["$updated_at", now]}, now]},
        field: {"$cond": [newer, {"$literal": record}, "$" + field]}
    }}], upsert=True)
    return revision


async def get_snapshot(video_id):
    """Return {video_id, revision, updated_at, events: {event: record}} or None."""
    return await collection().find_one({"_id": video_id}, {"_id": 0})


async def read_snapshots(limit=1000):
    """Return bounded latest snapshots, oldest publication first (no cursor).

    Pollers compare per-event `_revision`, sort changed records by it, and send
    records stripped of `_revision` and `_updated_at`. This is latest-state polling, NOT an event log.
    """
    return await collection().find({}, {"_id": 0}).sort("updated_at", -1).to_list(length=max(1, min(1000, int(limit))))


publish_event = publish
