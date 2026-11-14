import os
import time
import asyncio
from pathlib import Path
from typing import Dict, Any, List, Optional
from fastapi import WebSocket, WebSocketDisconnect
import httpx
import yt_dlp

from config import settings
from database import get_video, update_video
import drive_catalog

class ConnectionManager:
    """Manages active WebSocket connections for streaming real-time transfer telemetry."""
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: Dict[str, Any]):
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception:
                self.disconnect(connection)

manager = ConnectionManager()

# Track active downloads to prevent duplicate concurrent jobs
active_downloads: Dict[str, Dict[str, Any]] = {}

def format_bytes(bytes_count: int) -> str:
    """Format bytes into human-readable string (KB, MB, GB)."""
    if bytes_count < 1024:
        return f"{bytes_count} B"
    elif bytes_count < 1024 * 1024:
        return f"{bytes_count / 1024:.1f} KB"
    elif bytes_count < 1024 * 1024 * 1024:
        return f"{bytes_count / (1024 * 1024):.2f} MB"
    else:
        return f"{bytes_count / (1024 * 1024 * 1024):.2f} GB"

async def broadcast_progress(
    video_id: str,
    title: str,
    source: str,
    downloaded_bytes: int,
    total_bytes: int,
    speed_bytes_sec: float,
    status: str = "DOWNLOADING",
    error_message: Optional[str] = None
):
    """Calculates telemetry metrics and broadcasts JSON payload to all connected WebSockets."""
    pct = round((downloaded_bytes / total_bytes * 100), 1) if total_bytes > 0 else 0.0
    speed_mbs = round(speed_bytes_sec / (1024 * 1024), 2)
    remaining_bytes = max(0, total_bytes - downloaded_bytes)
    eta_sec = int(remaining_bytes / speed_bytes_sec) if speed_bytes_sec > 0 else 0

    payload = {
        "event": "TRANSFER_UPDATE",
        "video_id": video_id,
        "title": title,
        "source": source,
        "status": status,
        "percentage": min(100.0, pct),
        "downloaded_bytes": downloaded_bytes,
        "total_bytes": total_bytes,
        "downloaded_str": format_bytes(downloaded_bytes),
        "total_str": format_bytes(total_bytes),
        "remaining_str": format_bytes(remaining_bytes),
        "speed_mbs": speed_mbs,
        "eta_seconds": eta_sec,
        "error": error_message
    }
    
    active_downloads[video_id] = payload
    await manager.broadcast(payload)

async def download_drive_video(video_id: str):
    """
    On-Demand Google Drive High-Speed Stream Downloader.
    Downloads the remote file directly to /mnt/storage/videos/{video_id}.mp4.
    Once complete, triggers the automated FFmpeg processing pipeline.
    """
    video = await get_video(video_id)
    if not video or not video.get("drive_file_id"):
        return

    drive_file_id = video["drive_file_id"]
    title = video.get("title", f"Video {video_id}")
    dest_path = settings.videos_dir / f"{video_id}.mp4"

    # If file already exists and is local ready, return early
    if dest_path.exists() and video.get("status") == "LOCAL_READY":
        return

    await update_video(video_id, {"status": "DOWNLOADING"})
    
    try:
        service = drive_catalog.get_drive_service()
        auth_headers = drive_catalog.get_auth_headers(service)
        url = f"https://www.googleapis.com/drive/v3/files/{drive_file_id}?alt=media"

        async with httpx.AsyncClient(timeout=None, follow_redirects=True) as client:
            async with client.stream("GET", url, headers=auth_headers) as response:
                if response.status_code != 200:
                    raise RuntimeError(f"Google Drive returned HTTP {response.status_code}")

                total_bytes = int(response.headers.get("Content-Length") or video.get("file_size_bytes") or 0)
                downloaded_bytes = 0
                start_time = time.time()
                last_time = start_time
                last_bytes = 0

                with open(dest_path, "wb") as f:
                    async for chunk in response.aiter_bytes(chunk_size=1024 * 1024):  # 1MB chunks
                        f.write(chunk)
                        chunk_len = len(chunk)
                        downloaded_bytes += chunk_len

                        now = time.time()
                        time_diff = now - last_time
                        if time_diff >= 0.5 or downloaded_bytes == total_bytes:
                            speed = (downloaded_bytes - last_bytes) / time_diff if time_diff > 0 else 0
                            await broadcast_progress(
                                video_id=video_id,
                                title=title,
                                source="Google Drive (On-Demand)",
                                downloaded_bytes=downloaded_bytes,
                                total_bytes=total_bytes,
                                speed_bytes_sec=speed,
                                status="DOWNLOADING"
                            )
                            last_time = now
                            last_bytes = downloaded_bytes

        # Update local file status in DB
        await update_video(video_id, {
            "status": "PROCESSING",
            "local_path": str(dest_path),
            "file_size_bytes": downloaded_bytes
        })

        # Broadcast completion
        await broadcast_progress(
            video_id=video_id,
            title=title,
            source="Google Drive (On-Demand)",
            downloaded_bytes=downloaded_bytes,
            total_bytes=downloaded_bytes,
            speed_bytes_sec=0,
            status="DOWNLOAD_COMPLETE"
        )

        # Trigger background FFmpeg pipeline
        from ffmpeg_worker import process_video_background
        asyncio.create_task(process_video_background(video_id))

    except Exception as e:
        print(f"[Downloader] Error downloading Drive video {video_id}: {e}")
        await update_video(video_id, {"status": "FAILED"})
        await broadcast_progress(
            video_id=video_id,
            title=title,
            source="Google Drive (On-Demand)",
            downloaded_bytes=0,
            total_bytes=0,
            speed_bytes_sec=0,
            status="FAILED",
            error_message=str(e)
        )
    finally:
        active_downloads.pop(video_id, None)

async def download_external_url(video_id: str, url: str):
    """
    Downloads media from arbitrary HTTP links, direct MP4 URLs, YouTube, Vimeo, etc.
    Saves to /mnt/storage/videos/{video_id}.mp4 using yt-dlp with real-time telemetry.
    """
    video = await get_video(video_id)
    title = video.get("title", "External URL Video")
    dest_path = settings.videos_dir / f"{video_id}.mp4"

    loop = asyncio.get_running_loop()

    last_broadcast = {"time": time.time(), "bytes": 0}

    def ytdl_progress_hook(d):
        if d['status'] == 'downloading':
            total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
            downloaded = d.get('downloaded_bytes', 0)
            speed = d.get('speed') or 0
            
            now = time.time()
            if now - last_broadcast["time"] >= 0.5 or (total and downloaded >= total):
                last_broadcast["time"] = now
                asyncio.run_coroutine_threadsafe(
                    broadcast_progress(
                        video_id=video_id,
                        title=title,
                        source="External URL",
                        downloaded_bytes=downloaded,
                        total_bytes=total,
                        speed_bytes_sec=speed,
                        status="DOWNLOADING"
                    ),
                    loop
                )

    def run_ytdl():
        ydl_opts = {
            'outtmpl': str(dest_path),
            'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            'progress_hooks': [ytdl_progress_hook],
            'quiet': True,
            'no_warnings': True,
            'overwrites': True
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            return info

    try:
        info = await asyncio.to_thread(run_ytdl)
        actual_title = info.get("title") or title
        file_size = os.path.getsize(dest_path) if dest_path.exists() else 0

        await update_video(video_id, {
            "title": actual_title,
            "status": "PROCESSING",
            "local_path": str(dest_path),
            "file_size_bytes": file_size
        })

        await broadcast_progress(
            video_id=video_id,
            title=actual_title,
            source="External URL",
            downloaded_bytes=file_size,
            total_bytes=file_size,
            speed_bytes_sec=0,
            status="DOWNLOAD_COMPLETE"
        )

        from ffmpeg_worker import process_video_background
        asyncio.create_task(process_video_background(video_id))

    except Exception as e:
        print(f"[Downloader] Error in yt-dlp for {video_id}: {e}")
        await update_video(video_id, {"status": "FAILED"})
        await broadcast_progress(
            video_id=video_id,
            title=title,
            source="External URL",
            downloaded_bytes=0,
            total_bytes=0,
            speed_bytes_sec=0,
            status="FAILED",
            error_message=str(e)
        )
    finally:
        active_downloads.pop(video_id, None)
