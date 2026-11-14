import os
import re
import shutil
import asyncio
import time
import platform
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Optional, List, Dict, Any

from fastapi import (
    FastAPI, HTTPException, Request, Response, BackgroundTasks,
    WebSocket, WebSocketDisconnect, Depends, status, Query
)
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from bson import ObjectId

import psutil

from config import settings
from database import (
    init_db,
    close_db,
    get_db,
    list_videos,
    get_video,
    create_url_video,
    update_video,
    delete_video
)
from auth import (
    init_admin_user,
    get_user_by_username,
    verify_password,
    create_access_token,
    get_current_user,
    get_current_user_flexible,
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

# Global state for server throughput tracking
SERVER_START_TIME = time.time()
_last_net_time = time.time()
_last_net_bytes_recv = 0
_last_net_bytes_sent = 0
_current_in_rate_mb_s = 0.0
_current_out_rate_mb_s = 0.0

def update_network_rates():
    global _last_net_time, _last_net_bytes_recv, _last_net_bytes_sent
    global _current_in_rate_mb_s, _current_out_rate_mb_s

    try:
        net_io = psutil.net_io_counters()
        now = time.time()
        time_delta = now - _last_net_time

        if time_delta >= 1.0 and _last_net_bytes_recv > 0:
            recv_delta = max(0, net_io.bytes_recv - _last_net_bytes_recv)
            sent_delta = max(0, net_io.bytes_sent - _last_net_bytes_sent)

            _current_in_rate_mb_s = round(recv_delta / (1024 * 1024 * time_delta), 2)
            _current_out_rate_mb_s = round(sent_delta / (1024 * 1024 * time_delta), 2)

            _last_net_time = now
            _last_net_bytes_recv = net_io.bytes_recv
            _last_net_bytes_sent = net_io.bytes_sent
        elif _last_net_bytes_recv == 0:
            _last_net_time = now
            _last_net_bytes_recv = net_io.bytes_recv
            _last_net_bytes_sent = net_io.bytes_sent
    except Exception:
        pass

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Initialize MongoDB, ensure directories exist, seed admin user, prime network counters
    await init_db()
    await init_admin_user()
    try:
        await drive_catalog.load_drive_config_from_db()
    except Exception as e:
        print(f"[MediaServer] Notice: Could not load initial drive config: {e}")
    settings.videos_dir
    settings.metadata_dir
    try:
        net = psutil.net_io_counters()
        global _last_net_bytes_recv, _last_net_bytes_sent
        _last_net_bytes_recv = net.bytes_recv
        _last_net_bytes_sent = net.bytes_sent
    except Exception:
        pass
    print(f"[MediaServer] Initialized storage at {settings.STORAGE_DIR}")
    yield
    # Shutdown
    await close_db()

app = FastAPI(
    title="DriveConnector - High-Performance Self-Hosted Media Streaming Server",
    version="1.3.0",
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

class DriveConfigUpdate(BaseModel):
    auth_type: Optional[str] = None
    api_key: Optional[str] = None
    service_account_json: Optional[str] = None
    oauth_token: Optional[str] = None
    folder_id: Optional[str] = None
    clear_credentials: Optional[bool] = False

class DriveTestRequest(BaseModel):
    auth_type: Optional[str] = None
    api_key: Optional[str] = None
    service_account_json: Optional[str] = None
    oauth_token: Optional[str] = None
    folder_id: Optional[str] = None

class DbQueryRequest(BaseModel):
    filter: Optional[Dict[str, Any]] = {}
    limit: Optional[int] = 50

# ----------------- WebSocket Real-Time Telemetry (Auth Guarded) -----------------
@app.websocket("/ws/transfers")
async def websocket_transfers_endpoint(websocket: WebSocket, token: Optional[str] = Query(None)):
    """Strictly authenticated real-time transfer telemetry socket."""
    user = await validate_ws_token(token)
    if not user:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await manager.connect(websocket)
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

# ----------------- Video Catalog & Management Endpoints (Auth Guarded) -----------------
@app.get("/api/videos", response_model=List[Dict[str, Any]])
async def get_all_videos(
    status: Optional[str] = None,
    search: Optional[str] = None,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    """Returns all cataloged videos (Strictly Requires Authentication)."""
    return await list_videos(status=status, search=search)

@app.get("/api/videos/{video_id}")
async def get_single_video(
    video_id: str,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    valid_id = validate_video_id(video_id)
    video = await get_video(valid_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")
    return video

# ----------------- Drive Configuration Endpoints (Auth Guarded) -----------------
@app.get("/api/drive/config")
async def get_drive_config_endpoint(current_user: Dict[str, Any] = Depends(get_current_user)):
    """Returns current Google Drive integration configuration with masked credentials."""
    cfg = await drive_catalog.get_drive_config()
    return drive_catalog.mask_drive_config(cfg)

@app.post("/api/drive/config")
async def save_drive_config_endpoint(
    payload: DriveConfigUpdate,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    """Saves Google Drive API Key or Service Account credentials."""
    try:
        updated = await drive_catalog.save_drive_config(payload.model_dump(exclude_unset=True))
        return {
            "status": "success",
            "message": "Google Drive configuration saved successfully.",
            "config": drive_catalog.mask_drive_config(updated)
        }
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save drive configuration: {str(e)}")

@app.post("/api/drive/test")
async def test_drive_connection_endpoint(
    payload: Optional[DriveTestRequest] = None,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    """Tests connectivity to Google Drive API v3 with provided or saved credentials."""
    try:
        data = payload.model_dump(exclude_unset=True) if payload else None
        result = await drive_catalog.test_drive_connection(data)
        return result
    except Exception as e:
        return {"success": False, "message": f"Connection test failed: {str(e)}"}

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

# ----------------- RFC 7233 Range Streaming (Cryptographically Auth Guarded) -----------------
@app.get("/api/stream/{video_id}")
async def stream_video(
    video_id: str,
    request: Request,
    current_user: Dict[str, Any] = Depends(get_current_user_flexible)
):
    """
    Authenticated HTTP Range Request Streaming Engine.
    Accepts Authorization Header, ?token= parameter, or cookie.
    Unauthorized users cannot stream video content.
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
        def file_iterator():
            with open(video_path, "rb") as f:
                while chunk := f.read(1024 * 1024):
                    yield chunk

        headers = {
            "Content-Type": "video/mp4",
            "Content-Length": str(file_size),
            "Accept-Ranges": "bytes"
        }
        return StreamingResponse(file_iterator(), headers=headers)

    range_match = re.match(r"bytes=(\d*)-(\d*)", range_header.strip())
    if not range_match:
        raise HTTPException(status_code=416, detail="Invalid Range header format")

    raw_start, raw_end = range_match.groups()

    if raw_start == "" and raw_end == "":
        raise HTTPException(status_code=416, detail="Invalid Range parameters")

    if raw_start == "":
        suffix_length = int(raw_end)
        start = max(0, file_size - suffix_length)
        end = file_size - 1
    elif raw_end == "":
        start = int(raw_start)
        end = file_size - 1
    else:
        start = int(raw_start)
        end = min(int(raw_end), file_size - 1)

    if start >= file_size or start > end:
        raise HTTPException(
            status_code=416,
            detail="Requested range not satisfiable",
            headers={"Content-Range": f"bytes */{file_size}"}
        )

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

# ----------------- Hardware & Process Telemetry (Auth Guarded) -----------------
@app.get("/api/system/metrics")
async def get_system_metrics(current_user: Dict[str, Any] = Depends(get_current_user)):
    """Comprehensive Hardware & Operational Metrics (Requires Authentication)."""
    update_network_rates()

    # CPU metrics
    cpu_percent = 0.0
    cpu_cores = os.cpu_count() or 1
    cpu_freq = 0.0
    try:
        cpu_percent = psutil.cpu_percent(interval=None)
        freq = psutil.cpu_freq()
        if freq:
            cpu_freq = round(freq.current, 1)
    except Exception:
        pass

    # RAM metrics
    ram_total_gb = 16.0
    ram_used_gb = 2.0
    ram_free_gb = 14.0
    ram_percent = 12.5
    try:
        mem = psutil.virtual_memory()
        ram_total_gb = round(mem.total / (1024 ** 3), 2)
        ram_used_gb = round(mem.used / (1024 ** 3), 2)
        ram_free_gb = round(mem.available / (1024 ** 3), 2)
        ram_percent = round(mem.percent, 1)
    except Exception:
        pass

    # 1TB Storage Disk metrics
    storage_path = settings.STORAGE_DIR if os.path.exists(settings.STORAGE_DIR) else "."
    disk_total_gb = 1000.0
    disk_used_gb = 0.0
    disk_free_gb = 1000.0
    disk_percent = 0.0
    try:
        usage = shutil.disk_usage(storage_path)
        disk_total_gb = round(usage.total / (1024 ** 3), 2)
        disk_used_gb = round(usage.used / (1024 ** 3), 2)
        disk_free_gb = round(usage.free / (1024 ** 3), 2)
        disk_percent = round((usage.used / usage.total) * 100, 1) if usage.total > 0 else 0.0
    except Exception:
        pass

    # Network I/O metrics
    net_rx_mb = 0.0
    net_tx_mb = 0.0
    try:
        net_io = psutil.net_io_counters()
        net_rx_mb = round(net_io.bytes_recv / (1024 * 1024), 1)
        net_tx_mb = round(net_io.bytes_sent / (1024 * 1024), 1)
    except Exception:
        pass

    # Pipeline counts from MongoDB & active downloads
    db = get_db()
    total_files = await db["videos"].count_documents({})
    local_files = await db["videos"].count_documents({"status": "LOCAL_READY"})
    cloud_files = await db["videos"].count_documents({"status": "REMOTE_ONLY"})
    in_processing = await db["videos"].count_documents({"status": "PROCESSING"})
    in_queue = len(active_downloads)

    # Active download speed sum
    live_dl_speed = sum(
        t.get("speed_mbs", 0.0) for t in active_downloads.values() if t.get("status") == "DOWNLOADING"
    )

    uptime_sec = int(time.time() - SERVER_START_TIME)

    return {
        "cpu": {
            "percent": cpu_percent,
            "cores": cpu_cores,
            "frequency_mhz": cpu_freq
        },
        "ram": {
            "total_gb": ram_total_gb,
            "used_gb": ram_used_gb,
            "free_gb": ram_free_gb,
            "percent": ram_percent
        },
        "disk": {
            "mount": settings.STORAGE_DIR,
            "total_gb": disk_total_gb,
            "used_gb": disk_used_gb,
            "free_gb": disk_free_gb,
            "percent": disk_percent
        },
        "network": {
            "input_mb_s": _current_in_rate_mb_s,
            "output_mb_s": _current_out_rate_mb_s,
            "total_received_mb": net_rx_mb,
            "total_sent_mb": net_tx_mb
        },
        "pipeline": {
            "total_files": total_files,
            "local_files": local_files,
            "cloud_files": cloud_files,
            "in_queue": in_queue,
            "in_processing": in_processing,
            "completed": local_files
        },
        "throughput": {
            "live_download_speed_mb_s": round(live_dl_speed, 2),
            "live_stream_speed_mb_s": _current_out_rate_mb_s
        },
        "server": {
            "status": "optimal",
            "uptime_seconds": uptime_sec,
            "os": f"{platform.system()} {platform.release()}"
        }
    }

@app.get("/api/system/storage")
async def get_storage_stats(current_user: Dict[str, Any] = Depends(get_current_user)):
    """Returns disk usage metrics for the OVHcloud 1TB Block Storage (Requires Auth)."""
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

# ----------------- MongoDB Integrated UI & Management API -----------------
@app.get("/api/db/stats")
async def get_database_stats(current_user: Dict[str, Any] = Depends(get_current_user)):
    """Returns MongoDB collections, document counts, and storage stats (Requires Auth)."""
    db = get_db()
    collections_names = await db.list_collection_names()
    stats = []

    for name in collections_names:
        count = await db[name].count_documents({})
        stats.append({
            "name": name,
            "count": count
        })

    return {
        "database": settings.DATABASE_NAME,
        "collections": stats,
        "mongo_express_port": 8081,
        "mongo_express_url": "http://127.0.0.1:8081/"
    }

@app.get("/api/db/collections/{collection_name}")
async def get_collection_documents(
    collection_name: str,
    limit: int = 50,
    skip: int = 0,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    """Returns documents from a collection with sensitive fields redacted (Requires Auth)."""
    db = get_db()
    if collection_name not in ["videos", "users"]:
        raise HTTPException(status_code=400, detail="Invalid collection name")

    col = db[collection_name]
    cursor = col.find({}, {"_id": 0}).skip(skip).limit(min(100, limit))
    docs = await cursor.to_list(length=100)

    # Redact sensitive password hashes if users collection
    if collection_name == "users":
        for doc in docs:
            doc.pop("password_hash", None)

    total = await col.count_documents({})
    return {
        "collection": collection_name,
        "total": total,
        "limit": limit,
        "skip": skip,
        "documents": docs
    }

@app.delete("/api/db/collections/{collection_name}/{doc_id}")
async def delete_collection_document(
    collection_name: str,
    doc_id: str,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    """Deletes a document from the MongoDB collection (Requires Auth)."""
    db = get_db()
    if collection_name not in ["videos", "users"]:
        raise HTTPException(status_code=400, detail="Invalid collection name")

    col = db[collection_name]
    # Delete by video_id or username
    if collection_name == "videos":
        res = await col.delete_one({"video_id": doc_id})
    else:
        if doc_id == settings.ADMIN_USERNAME:
            raise HTTPException(status_code=400, detail="Cannot delete default admin user")
        res = await col.delete_one({"username": doc_id})

    return {"deleted": res.deleted_count > 0, "collection": collection_name, "id": doc_id}

@app.get("/api/health")
async def health_check():
    return {"status": "ok", "app": "drive_connector", "version": "1.3.0"}
