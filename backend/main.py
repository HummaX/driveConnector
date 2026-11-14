import os
import re
import shutil
import asyncio
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Optional, List, Dict, Any

from fastapi import FastAPI, HTTPException, Request, Response, BackgroundTasks, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from config import settings
from database import (
    init_db,
    close_db,
    list_videos,
    get_video,
    create_url_video,
    update_video,
    delete_video
)
import drive_catalog
from downloader import (
    manager,
    download_drive_video,
    download_external_url,
    active_downloads
)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Initialize MongoDB and ensure disk directories exist
    await init_db()
    settings.videos_dir
    settings.metadata_dir
    print(f"[MediaServer] Initialized storage at {settings.STORAGE_DIR}")
    yield
    # Shutdown: Close DB connection pool
    await close_db()

app = FastAPI(
    title="High-Performance Self-Hosted Media Streaming Server",
    version="1.0.0",
    lifespan=lifespan
)

# Enable CORS for React/Vite/Next.js and external frontends
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static asset directory for thumbnails, previews, and WebVTT sprite files
app.mount("/metadata", StaticFiles(directory=str(settings.metadata_dir)), name="metadata")

# Mount built-in single-page Web UI
static_ui_dir = Path(__file__).parent / "static"
if static_ui_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_ui_dir)), name="static")

@app.get("/", include_in_schema=False)
async def serve_root():
    index_file = static_ui_dir / "index.html"
    if index_file.exists():
        return FileResponse(str(index_file))
    return {"status": "ok", "message": "DriveConnector API running"}


# ----------------- Request Schemas -----------------
class DownloadUrlRequest(BaseModel):
    url: str
    title: Optional[str] = None

class SyncDriveRequest(BaseModel):
    folder_id: Optional[str] = None

# ----------------- WebSocket Real-Time Telemetry -----------------
@app.websocket("/ws/transfers")
async def websocket_transfers_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    # Send currently active downloads immediately upon connection
    for v_id, state in active_downloads.items():
        await websocket.send_json(state)
    try:
        while True:
            # Keep connection alive; accept any client messages
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)

# ----------------- Video Catalog & Management Endpoints -----------------
@app.get("/api/videos", response_model=List[Dict[str, Any]])
async def get_all_videos(status: Optional[str] = None, search: Optional[str] = None):
    """Returns all cataloged videos (both REMOTE_ONLY cloud catalog and LOCAL_READY videos)."""
    return await list_videos(status=status, search=search)

@app.get("/api/videos/{video_id}")
async def get_single_video(video_id: str):
    video = await get_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")
    return video

@app.post("/api/videos/sync-drive")
async def sync_drive(payload: Optional[SyncDriveRequest] = None, background_tasks: BackgroundTasks = None):
    """
    Lightweight Google Drive Catalog Sync:
    Scans Google Drive folder for videos, downloads poster thumbnails, and inserts records as REMOTE_ONLY.
    """
    folder_id = payload.folder_id if payload else None
    try:
        # Run sync in thread/task so it doesn't block
        result = await drive_catalog.sync_drive_catalog(folder_id=folder_id)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to sync Google Drive: {str(e)}")

@app.post("/api/videos/{video_id}/download")
async def trigger_drive_download(video_id: str, background_tasks: BackgroundTasks):
    """
    Triggers on-demand high-speed download for a Google Drive REMOTE_ONLY video.
    """
    video = await get_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    if video.get("status") == "LOCAL_READY":
        return {"message": "Video is already downloaded and ready", "status": "LOCAL_READY"}

    # Start download task asynchronously
    background_tasks.add_task(download_drive_video, video_id)
    return {"message": "Download started", "video_id": video_id, "status": "DOWNLOADING"}

@app.post("/api/videos/download-url")
async def trigger_url_download(payload: DownloadUrlRequest, background_tasks: BackgroundTasks):
    """
    Downloads any external video link or YouTube/Vimeo URL directly to /mnt/storage/videos/.
    """
    video = await create_url_video(url=payload.url, title=payload.title)
    video_id = video["video_id"]
    background_tasks.add_task(download_external_url, video_id, payload.url)
    return {"message": "URL Download queued", "video": video}

@app.delete("/api/videos/{video_id}")
async def remove_video(video_id: str):
    """Deletes the video, local files, and metadata directory from 1TB storage and MongoDB."""
    video = await get_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    # 1. Remove local video file
    local_path = video.get("local_path")
    if local_path and os.path.exists(local_path):
        try:
            os.remove(local_path)
        except OSError:
            pass

    # 2. Remove metadata directory
    meta_dir = settings.metadata_dir / video_id
    if meta_dir.exists():
        try:
            shutil.rmtree(meta_dir)
        except OSError:
            pass

    # 3. Delete from MongoDB
    await delete_video(video_id)
    return {"status": "deleted", "video_id": video_id}

# ----------------- HTTP 206 Partial Content Streaming Engine -----------------
@app.get("/api/stream/{video_id}")
async def stream_video(video_id: str, request: Request):
    """
    High-Performance HTTP Range Request Streaming Endpoint.
    Streams video chunks directly from /mnt/storage/videos/{video_id}.mp4.
    Supports smooth seeking, scrubber scrubbing, and bandwidth optimization.
    """
    video = await get_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found in catalog")

    local_path_str = video.get("local_path")
    video_path = Path(local_path_str) if local_path_str else settings.videos_dir / f"{video_id}.mp4"

    # If the video is still on cloud, report that download is required
    if not video_path.exists() or video.get("status") == "REMOTE_ONLY":
        raise HTTPException(
            status_code=409,
            detail={"error": "VIDEO_REMOTE_ONLY", "message": "Video is stored on cloud. Click to fetch locally."}
        )

    file_size = video_path.stat().st_size
    range_header = request.headers.get("range")

    if not range_header:
        # Full file stream fallback (if client did not send Range header)
        def file_iterator():
            with open(video_path, "rb") as f:
                while chunk := f.read(1024 * 1024):  # 1MB buffer
                    yield chunk

        headers = {
            "Content-Type": "video/mp4",
            "Content-Length": str(file_size),
            "Accept-Ranges": "bytes"
        }
        return StreamingResponse(file_iterator(), headers=headers)

    # Parse Range: bytes=start-end
    match = re.match(r"bytes=(\d+)-(\d*)", range_header)
    if not match:
        raise HTTPException(status_code=416, detail="Invalid Range header format")

    start = int(match.group(1))
    end = int(match.group(2)) if match.group(2) else file_size - 1

    if start >= file_size or end >= file_size or start > end:
        raise HTTPException(
            status_code=416,
            detail="Requested range not satisfiable",
            headers={"Content-Range": f"bytes */{file_size}"}
        )

    # Restrict maximum chunk response size to 4MB for responsive seeking and low memory footprint
    max_chunk = 4 * 1024 * 1024
    if (end - start + 1) > max_chunk:
        end = start + max_chunk - 1

    content_length = end - start + 1

    def range_stream():
        with open(video_path, "rb") as f:
            f.seek(start)
            remaining = content_length
            while remaining > 0:
                chunk_size = min(remaining, 512 * 1024)  # 512KB read blocks
                data = f.read(chunk_size)
                if not data:
                    break
                remaining -= len(data)
                yield data

    headers = {
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(content_length),
        "Content-Type": "video/mp4",
        "Cache-Control": "no-cache",
    }

    return StreamingResponse(
        range_stream(),
        status_code=206,
        headers=headers
    )

# ----------------- System & Storage Telemetry -----------------
@app.get("/api/system/storage")
async def get_storage_stats():
    """Returns disk usage metrics for the OVHcloud 1TB Block Storage mount point."""
    storage_path = settings.STORAGE_DIR if os.path.exists(settings.STORAGE_DIR) else "."
    total, used, free = shutil.disk_usage(storage_path)

    def to_gb(b):
        return round(b / (1024 ** 3), 2)

    return {
        "mount_point": settings.STORAGE_DIR,
        "total_gb": to_gb(total),
        "used_gb": to_gb(used),
        "free_gb": to_gb(free),
        "used_percent": round((used / total) * 100, 1)
    }

@app.get("/api/health")
async def health_check():
    return {"status": "ok", "app": "media_server"}
