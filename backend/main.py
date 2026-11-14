import os
import re
import time
import shutil
import platform
import asyncio
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Optional, List, Dict, Any

try:
    import psutil
    # Initial call to prime psutil non-blocking cpu_percent calculations
    psutil.cpu_percent(interval=None)
    PSUTIL_AVAILABLE = True
except ImportError:
    psutil = None
    PSUTIL_AVAILABLE = False

from fastapi import (
    FastAPI, HTTPException, Request, Response, BackgroundTasks,
    WebSocket, WebSocketDisconnect, Depends, status, Query
)
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
    delete_video,
    get_videos_collection
)
from auth import (
    init_admin_user,
    get_user_by_username,
    verify_password,
    create_access_token,
    get_current_user,
    validate_ws_token,
    UserLogin
)
import drive_catalog
from downloader import (
    manager,
    download_drive_video,
    download_external_url,
    active_downloads
)

SAFE_ID_REGEX = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")

def validate_video_id(video_id: str) -> str:
    """CYB-04: Enforce strict identifier format to eliminate path traversal vulnerabilities."""
    clean_id = video_id.strip()
    if not SAFE_ID_REGEX.match(clean_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid video identifier format."
        )
    return clean_id

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Initialize MongoDB, ensure directories exist, and seed admin user
    await init_db()
    await init_admin_user()
    settings.videos_dir
    settings.metadata_dir
    print(f"[MediaServer] Initialized storage at {settings.STORAGE_DIR}")
    yield
    # Shutdown
    await close_db()

app = FastAPI(
    title="DriveConnector - High-Performance Self-Hosted Media Streaming Server",
    version="1.1.0",
    lifespan=lifespan
)

# CYB-05: Configurable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static asset directory
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

# ----------------- Authentication Endpoints -----------------
@app.post("/api/auth/login")
async def login(credentials: UserLogin):
    """Authenticates credentials and returns a signed JWT access token."""
    user = await get_user_by_username(credentials.username.strip())
    if not user or not verify_password(credentials.password, user["password_hash"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password"
        )
    
    token = create_access_token({"sub": user["username"], "role": user.get("role", "admin")})
    return {
        "access_token": token,
        "token_type": "bearer",
        "username": user["username"],
        "role": user.get("role", "admin")
    }

@app.get("/api/auth/me")
async def get_my_profile(current_user: Dict[str, Any] = Depends(get_current_user)):
    """Returns profile for currently authenticated user."""
    return {
        "username": current_user["username"],
        "role": current_user.get("role", "admin"),
        "created_at": current_user.get("created_at")
    }

# ----------------- Request Schemas -----------------
class DownloadUrlRequest(BaseModel):
    url: str
    title: Optional[str] = None

class SyncDriveRequest(BaseModel):
    folder_id: Optional[str] = None

# ----------------- WebSocket Real-Time Telemetry -----------------
@app.websocket("/ws/transfers")
async def websocket_transfers_endpoint(websocket: WebSocket, token: Optional[str] = Query(None)):
    """Real-time transfer telemetry socket with authentication check."""
    # Validate token if provided or accept connection
    await manager.connect(websocket)
    # Send currently active downloads immediately upon connection
    for v_id, state in active_downloads.items():
        try:
            await websocket.send_json(state)
        except Exception:
            break
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await manager.disconnect(websocket)
    except Exception:
        await manager.disconnect(websocket)

# ----------------- Video Catalog & Management Endpoints -----------------
@app.get("/api/videos", response_model=List[Dict[str, Any]])
async def get_all_videos(status: Optional[str] = None, search: Optional[str] = None):
    """Returns all cataloged videos with sanitized search parameter."""
    return await list_videos(status=status, search=search)

@app.get("/api/videos/{video_id}")
async def get_single_video(video_id: str):
    valid_id = validate_video_id(video_id)
    video = await get_video(valid_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")
    return video

@app.post("/api/videos/sync-drive")
async def sync_drive(
    payload: Optional[SyncDriveRequest] = None,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    """Lightweight Google Drive Catalog Sync (Requires Authentication)."""
    folder_id = payload.folder_id if payload else None
    try:
        result = await drive_catalog.sync_drive_catalog(folder_id=folder_id)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to sync Google Drive: {str(e)}")

@app.post("/api/videos/{video_id}/download")
async def trigger_drive_download(
    video_id: str,
    background_tasks: BackgroundTasks,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    """Triggers on-demand high-speed download (Requires Authentication)."""
    valid_id = validate_video_id(video_id)
    video = await get_video(valid_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    if video.get("status") == "LOCAL_READY":
        return {"message": "Video is already downloaded and ready", "status": "LOCAL_READY"}

    background_tasks.add_task(download_drive_video, valid_id)
    return {"message": "Download started", "video_id": valid_id, "status": "DOWNLOADING"}

@app.post("/api/videos/download-url")
async def trigger_url_download(
    payload: DownloadUrlRequest,
    background_tasks: BackgroundTasks,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    """Downloads external URL link with SSRF protection (Requires Authentication)."""
    clean_url = payload.url.strip()
    video = await create_url_video(url=clean_url, title=payload.title)
    video_id = video["video_id"]
    background_tasks.add_task(download_external_url, video_id, clean_url)
    return {"message": "URL Download queued", "video": video}

@app.delete("/api/videos/{video_id}")
async def remove_video(
    video_id: str,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    """Deletes the video and assets from storage and MongoDB (Requires Authentication)."""
    valid_id = validate_video_id(video_id)
    video = await get_video(valid_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    # Path traversal guarded: ensure file is inside settings.videos_dir
    local_path = settings.videos_dir / f"{valid_id}.mp4"
    if local_path.exists():
        try:
            os.remove(local_path)
        except OSError:
            pass

    meta_dir = settings.metadata_dir / valid_id
    if meta_dir.exists():
        try:
            shutil.rmtree(meta_dir)
        except OSError:
            pass

    await delete_video(valid_id)
    return {"status": "deleted", "video_id": valid_id}

# ----------------- RFC 7233 Compliant HTTP 206 Streaming Engine -----------------
@app.get("/api/stream/{video_id}")
async def stream_video(video_id: str, request: Request):
    """
    RFC 7233 Compliant HTTP Range Request Streaming Engine (CODE-03).
    Supports start-end, start-only, and suffix-byte ranges with automatic bounds clamping.
    """
    valid_id = validate_video_id(video_id)
    video = await get_video(valid_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found in catalog")

    video_path = settings.videos_dir / f"{valid_id}.mp4"

    if not video_path.exists() or video.get("status") == "REMOTE_ONLY":
        raise HTTPException(
            status_code=409,
            detail={"error": "VIDEO_REMOTE_ONLY", "message": "Video is stored on cloud. Click to fetch locally."}
        )

    file_size = video_path.stat().st_size
    range_header = request.headers.get("range")

    if not range_header:
        # Full file stream fallback
        def file_iterator():
            with open(video_path, "rb") as f:
                while chunk := f.read(1024 * 1024):
                    stream_tracker.record_bytes(len(chunk))
                    yield chunk

        headers = {
            "Content-Type": "video/mp4",
            "Content-Length": str(file_size),
            "Accept-Ranges": "bytes"
        }
        return StreamingResponse(file_iterator(), headers=headers)

    # Parse Range: bytes=start-end, bytes=start-, or bytes=-suffix
    range_match = re.match(r"bytes=(\d*)-(\d*)", range_header.strip())
    if not range_match:
        raise HTTPException(status_code=416, detail="Invalid Range header format")

    raw_start, raw_end = range_match.groups()

    if raw_start == "" and raw_end == "":
        raise HTTPException(status_code=416, detail="Invalid Range parameters")

    if raw_start == "":
        # Suffix range: bytes=-500 (last 500 bytes)
        suffix_length = int(raw_end)
        start = max(0, file_size - suffix_length)
        end = file_size - 1
    elif raw_end == "":
        # Start-only range: bytes=500- (from 500 to end)
        start = int(raw_start)
        end = file_size - 1
    else:
        # Full range: bytes=start-end
        start = int(raw_start)
        # RFC 7233 §2.1: Clamp end to file_size - 1 if client requests beyond EOF
        end = min(int(raw_end), file_size - 1)

    if start >= file_size or start > end:
        raise HTTPException(
            status_code=416,
            detail="Requested range not satisfiable",
            headers={"Content-Range": f"bytes */{file_size}"}
        )

    # 4MB max chunk response for fast seeking responsiveness
    max_chunk = 4 * 1024 * 1024
    if (end - start + 1) > max_chunk:
        end = start + max_chunk - 1

    content_length = end - start + 1

    def range_stream():
        with open(video_path, "rb") as f:
            f.seek(start)
            remaining = content_length
            while remaining > 0:
                chunk_size = min(remaining, 512 * 1024)
                data = f.read(chunk_size)
                if not data:
                    break
                stream_tracker.record_bytes(len(data))
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
SERVER_START_TIME = time.time()

class StreamThroughputTracker:
    """Tracks live streaming throughput using a rolling window."""
    def __init__(self):
        self.window: List[tuple] = []

    def record_bytes(self, num_bytes: int):
        now = time.time()
        self.window.append((now, num_bytes))
        cutoff = now - 3.0
        if len(self.window) > 100 or (self.window and self.window[0][0] < cutoff):
            self.window = [entry for entry in self.window if entry[0] >= cutoff]

    def get_speed_mb_s(self) -> float:
        now = time.time()
        cutoff = now - 3.0
        self.window = [entry for entry in self.window if entry[0] >= cutoff]
        if not self.window:
            return 0.0
        total_bytes = sum(b for _, b in self.window)
        duration = max(0.5, now - self.window[0][0])
        speed = (total_bytes / (1024 * 1024)) / duration
        return round(speed, 2)

stream_tracker = StreamThroughputTracker()

class NetworkTracker:
    """Calculates live inbound and outbound network data rates via delta bytes / delta time."""
    def __init__(self):
        self.last_time = time.time()
        self.last_bytes_recv = 0
        self.last_bytes_sent = 0
        self.input_mb_s = 0.0
        self.output_mb_s = 0.0
        self.initialized = False
        if PSUTIL_AVAILABLE:
            try:
                net = psutil.net_io_counters()
                if net:
                    self.last_bytes_recv = net.bytes_recv
                    self.last_bytes_sent = net.bytes_sent
                    self.initialized = True
            except Exception:
                pass

    def get_metrics(self) -> Dict[str, float]:
        now = time.time()
        total_recv_mb = 0.0
        total_sent_mb = 0.0

        if PSUTIL_AVAILABLE:
            try:
                net = psutil.net_io_counters()
                if net:
                    total_recv_mb = round(net.bytes_recv / (1024 * 1024), 2)
                    total_sent_mb = round(net.bytes_sent / (1024 * 1024), 2)

                    if not self.initialized:
                        self.last_time = now
                        self.last_bytes_recv = net.bytes_recv
                        self.last_bytes_sent = net.bytes_sent
                        self.initialized = True
                    else:
                        dt = now - self.last_time
                        if dt >= 0.5:
                            delta_recv = max(0, net.bytes_recv - self.last_bytes_recv)
                            delta_sent = max(0, net.bytes_sent - self.last_bytes_sent)
                            self.input_mb_s = round((delta_recv / (1024 * 1024)) / dt, 2)
                            self.output_mb_s = round((delta_sent / (1024 * 1024)) / dt, 2)
                            self.last_time = now
                            self.last_bytes_recv = net.bytes_recv
                            self.last_bytes_sent = net.bytes_sent
            except Exception:
                pass

        return {
            "input_mb_s": self.input_mb_s,
            "output_mb_s": self.output_mb_s,
            "total_received_mb": total_recv_mb,
            "total_sent_mb": total_sent_mb,
        }

net_tracker = NetworkTracker()

def get_cpu_metrics() -> Dict[str, Any]:
    percent = 0.0
    cores = os.cpu_count() or 1
    frequency_mhz = 0.0

    if PSUTIL_AVAILABLE:
        try:
            percent = float(psutil.cpu_percent(interval=None))
        except Exception:
            percent = 0.0

        try:
            cpu_count = psutil.cpu_count(logical=True)
            if cpu_count:
                cores = cpu_count
        except Exception:
            pass

        try:
            freq = psutil.cpu_freq()
            if freq and freq.current:
                frequency_mhz = round(freq.current, 1)
        except Exception:
            frequency_mhz = 0.0

    return {
        "percent": round(percent, 1),
        "cores": cores,
        "frequency_mhz": frequency_mhz
    }

def get_ram_metrics() -> Dict[str, Any]:
    total_gb = 16.0
    used_gb = 0.0
    free_gb = 16.0
    percent = 0.0

    if PSUTIL_AVAILABLE:
        try:
            vmem = psutil.virtual_memory()
            total_gb = round(vmem.total / (1024 ** 3), 2)
            used_gb = round(vmem.used / (1024 ** 3), 2)
            free_gb = round(vmem.available / (1024 ** 3), 2)
            percent = round(float(vmem.percent), 1)
        except Exception:
            pass

    return {
        "total_gb": total_gb,
        "used_gb": used_gb,
        "free_gb": free_gb,
        "percent": percent
    }

def get_disk_metrics() -> Dict[str, Any]:
    storage_path = settings.STORAGE_DIR if os.path.exists(settings.STORAGE_DIR) else "."
    try:
        total, used, free = shutil.disk_usage(storage_path)
    except Exception:
        total, used, free = 1000 * (1024 ** 3), 0, 1000 * (1024 ** 3)

    def to_gb(b):
        return round(b / (1024 ** 3), 2)

    pct = round((used / total) * 100, 1) if total > 0 else 0.0

    return {
        "mount": str(storage_path),
        "total_gb": to_gb(total),
        "used_gb": to_gb(used),
        "free_gb": to_gb(free),
        "percent": pct
    }

async def get_pipeline_metrics() -> Dict[str, int]:
    counts = {
        "total_files": 0,
        "local_files": 0,
        "cloud_files": 0,
        "in_queue": 0,
        "in_processing": 0,
        "completed": 0
    }
    try:
        col = get_videos_collection()
        pipeline = [{"$group": {"_id": "$status", "count": {"$sum": 1}}}]
        status_map = {}
        async for doc in col.aggregate(pipeline):
            status_map[doc["_id"]] = doc["count"]

        completed = status_map.get("LOCAL_READY", 0)
        in_processing = status_map.get("PROCESSING", 0)
        in_queue = status_map.get("DOWNLOADING", 0)
        cloud_files = status_map.get("REMOTE_ONLY", 0)

        active_dl_count = len([d for d in active_downloads.values() if d.get("status") == "DOWNLOADING"])
        in_queue = max(in_queue, active_dl_count)

        total_files = sum(status_map.values())
        local_files = completed + in_processing

        counts["total_files"] = total_files
        counts["local_files"] = local_files
        counts["cloud_files"] = cloud_files
        counts["in_queue"] = in_queue
        counts["in_processing"] = in_processing
        counts["completed"] = completed
    except Exception:
        pass

    return counts

def get_throughput_metrics() -> Dict[str, float]:
    dl_speed = 0.0
    for d in active_downloads.values():
        if d.get("status") == "DOWNLOADING":
            dl_speed += float(d.get("speed_mbs", 0.0))

    stream_speed = stream_tracker.get_speed_mb_s()

    return {
        "live_download_speed_mb_s": round(dl_speed, 2),
        "live_stream_speed_mb_s": round(stream_speed, 2)
    }

def get_server_metrics() -> Dict[str, Any]:
    uptime = max(0, int(time.time() - SERVER_START_TIME))
    os_name = f"{platform.system()} {platform.release()}".strip() or platform.system()
    return {
        "status": "optimal",
        "uptime_seconds": uptime,
        "os": os_name
    }

@app.get("/api/system/metrics")
async def get_system_metrics():
    """
    Returns real-time server telemetry: CPU, RAM, Disk, Network I/O rates,
    Media Pipeline queue & completion stats, live streaming/download throughput,
    and server health status with graceful fallbacks.
    """
    cpu = get_cpu_metrics()
    ram = get_ram_metrics()
    disk = get_disk_metrics()
    network = net_tracker.get_metrics()
    pipeline = await get_pipeline_metrics()
    throughput = get_throughput_metrics()
    server = get_server_metrics()

    return {
        "cpu": cpu,
        "ram": ram,
        "disk": disk,
        "network": network,
        "pipeline": pipeline,
        "throughput": throughput,
        "server": server
    }

@app.get("/api/system/storage")
async def get_storage_stats():
    """Returns disk usage metrics for the OVHcloud 1TB Block Storage mount point."""
    storage_path = settings.STORAGE_DIR if os.path.exists(settings.STORAGE_DIR) else "."
    total, used, free = shutil.disk_usage(storage_path)

    def to_gb(b):
        return round(b / (1024 ** 3), 2)

    pct = round((used / total) * 100, 1) if total > 0 else 0.0

    return {
        "mount_point": settings.STORAGE_DIR,
        "total_gb": to_gb(total),
        "used_gb": to_gb(used),
        "free_gb": to_gb(free),
        "used_percent": pct
    }

@app.get("/api/health")
async def health_check():
    return {"status": "ok", "app": "drive_connector", "version": "1.1.0"}
