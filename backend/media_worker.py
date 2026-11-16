"""Bounded durable media worker: python -m media_worker (Linux only).

Each claim runs in its own process/session. Cancellation of yt-dlp/Whisper
threads is not termination: ownership is released only after process shutdown.
No worker starts at import time. External JDownloader dispatch is disabled in
worker mode because it is outside this supervisor's stoppable process tree.
"""
import asyncio
import json
import os
import signal
import socket
import sys
import time
import uuid
from pathlib import Path

import database
import job_queue


class IsolationFailure(RuntimeError):
    """Stop the supervisor instead of accepting more work with an unowned child."""


def isolation_supported():
    return sys.platform.startswith("linux") and hasattr(os, "killpg") and Path("/proc/self/stat").is_file()


def group_stopped(pgid):
    """Verify no live process remains; zombies cannot execute or write files."""
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return True
    except (PermissionError, OSError):
        return False
    try:
        for item in Path("/proc").iterdir():
            if not item.name.isdigit():
                continue
            try:
                stat = (item / "stat").read_text()
            except (FileNotFoundError, ProcessLookupError):
                continue
            fields = stat[stat.rfind(")") + 2:].split()
            if int(fields[2]) == pgid and fields[0] not in ("Z", "X"):
                return False
        return True
    except (OSError, ValueError, IndexError):
        return False


async def stop_process(proc):
    """Kill the entire isolated group, reap the leader, verify no live children."""
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except OSError:
        return False
    try:
        await asyncio.wait_for(proc.wait(), timeout=15)
    except (asyncio.TimeoutError, OSError):
        return False
    deadline = time.monotonic() + 5
    while not group_stopped(proc.pid):
        if time.monotonic() >= deadline:
            return False
        await asyncio.sleep(0.05)
    return True


async def execute(job):
    import downloader
    import ffmpeg_worker
    token = downloader.worker_inline_processing.set(True)
    try:
        await _execute_operation(job, downloader, ffmpeg_worker)
    finally:
        downloader.worker_inline_processing.reset(token)


async def _execute_operation(job, downloader, ffmpeg_worker):
    kind, video_id, payload = job["kind"], job["video_id"], job.get("payload") or {}
    if kind == "download_drive":
        await downloader.download_drive_video(video_id)
    elif kind == "download_url":
        video = await database.get_video(video_id)
        if not video or not video.get("url"):
            raise RuntimeError("Video URL unavailable")
        await downloader.download_external_url(video_id, video["url"], payload.get("engine", "auto"))
    elif kind == "process":
        await ffmpeg_worker.process_video_background(video_id)
    elif kind == "transcode":
        if payload.get("quality", "720p").lower() not in ffmpeg_worker.QUALITY_PRESETS:
            raise ValueError("Unsupported transcode quality")
        await ffmpeg_worker.transcode_video(video_id, payload.get("quality", "720p"), payload.get("replace_original", False))
    elif kind == "transcribe":
        await ffmpeg_worker.transcribe_video(video_id)
    else:
        raise ValueError("Unsupported job")
    video = await database.get_video(video_id)
    if not video or video.get("status") == "FAILED":
        raise RuntimeError("Media operation failed")


async def _stall(job, error):
    # A database outage can prevent this write. The retained running lease will
    # later become stalled in claim_job; it is never available for reclaim.
    try:
        await asyncio.wait_for(job_queue.stall_job(job, error), timeout=10)
    except Exception:
        pass


async def run_claim(job):
    if not isolation_supported():
        await _stall(job, "Process isolation unsupported; worker fails closed")
        return
    proc = None
    stopped = False
    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "media_worker", "--job-child",
            cwd=str(Path(__file__).resolve().parent), start_new_session=True,
            stdin=asyncio.subprocess.PIPE)
        # Child blocks on stdin before touching the DB/storage/network. Save its
        # PID/group under the ownership fence before granting execution.
        if not await asyncio.wait_for(job_queue.record_process(job, proc.pid), timeout=10):
            raise RuntimeError("Claim lost before child launch")
        child_job = {key: job[key] for key in ("kind", "video_id", "payload") if key in job}
        proc.stdin.write(json.dumps(child_job).encode())
        await proc.stdin.drain()
        proc.stdin.close()
        timeout = max(60, min(86400, int(os.environ.get("MEDIA_JOB_TIMEOUT_SECONDS", "21600"))))
        deadline = time.monotonic() + timeout
        error = None
        while True:
            try:
                await asyncio.wait_for(asyncio.shield(proc.wait()), timeout=min(30, max(0.01, deadline - time.monotonic())))
                error = None if proc.returncode == 0 else "ChildExit(%s)" % proc.returncode
                break
            except asyncio.TimeoutError:
                if time.monotonic() >= deadline:
                    error = "JobTimeout"
                    break
                if not await asyncio.wait_for(job_queue.heartbeat(job), timeout=10):
                    raise RuntimeError("Worker lease lost")
        stopped = await stop_process(proc)
        if not stopped:
            await _stall(job, "Cannot verify child process tree stopped")
            raise IsolationFailure("Process shutdown unverified; refusing more claims")
        completed = await asyncio.wait_for(job_queue.finish_job(job, error, process_stopped=True), timeout=10)
        if not completed:
            await _stall(job, "Completion lease lost; operator recovery required")
    except asyncio.CancelledError:
        if proc is not None:
            stopped = await asyncio.shield(stop_process(proc))
        await _stall(job, "Worker interrupted; operator recovery required" if stopped else "Worker interrupted; process shutdown unverified")
        raise
    except IsolationFailure:
        raise
    except Exception as exc:
        if proc is not None and not stopped:
            stopped = await stop_process(proc)
        # Control-plane errors may imply lease loss or uncertain process launch.
        await _stall(job, type(exc).__name__ + "; operator recovery required")
        if proc is not None and not stopped:
            raise IsolationFailure("Process shutdown unverified; refusing more claims") from exc


async def worker_loop(worker_id):
    while True:
        job = await job_queue.claim_job(worker_id)
        if job is None:
            await asyncio.sleep(2)
        else:
            await run_claim(job)


async def report_worker(worker_id):
    while True:
        await job_queue.worker_seen(worker_id)
        await asyncio.sleep(20)


async def child_main():
    if not isolation_supported() or os.getpgrp() != os.getpid():
        raise RuntimeError("Child is not in an isolated session")
    # Parent closes stdin only after durably recording process ownership.
    raw = await asyncio.to_thread(sys.stdin.buffer.read, 65537)
    if not raw or len(raw) > 65536:
        raise ValueError("Invalid job message")
    job = json.loads(raw)
    await database.init_db()
    try:
        await execute(job)
    finally:
        await database.close_db()


async def main():
    if not isolation_supported():
        raise RuntimeError("Durable media worker requires Linux process-group isolation; refusing to claim jobs")
    concurrency = max(1, min(8, int(os.environ.get("MEDIA_WORKER_CONCURRENCY", "2"))))
    await database.init_db()
    tasks = []
    try:
        await job_queue.init_queue()
        import job_events
        await job_events.init_indexes()
        worker_id = socket.gethostname() + "-" + uuid.uuid4().hex
        tasks = [asyncio.create_task(worker_loop(worker_id + "-" + str(i))) for i in range(concurrency)]
        tasks.append(asyncio.create_task(report_worker(worker_id)))
        await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await database.close_db()


if __name__ == "__main__":
    try:
        asyncio.run(child_main() if sys.argv[1:] == ["--job-child"] else main())
    except KeyboardInterrupt:
        pass
