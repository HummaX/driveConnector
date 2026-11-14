import os
import time
import json
import shutil
import socket
import ipaddress
import asyncio
from urllib.parse import urlparse
from pathlib import Path
from typing import Dict, Any, List, Optional
from fastapi import WebSocket, WebSocketDisconnect
import httpx
import yt_dlp

from config import settings
from database import get_video, update_video
import drive_catalog

class ConnectionManager:
    """Thread-safe manager for active WebSocket telemetry connections."""
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        async with self._lock:
            self.active_connections.append(websocket)

    async def disconnect(self, websocket: WebSocket):
        async with self._lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)

    async def broadcast(self, message: Dict[str, Any]):
        async with self._lock:
            connections = list(self.active_connections)
        
        for connection in connections:
            try:
                await connection.send_json(message)
            except Exception:
                await self.disconnect(connection)

manager = ConnectionManager()

# Global lock and active downloads map to prevent concurrent duplicate jobs
_download_lock = asyncio.Lock()
active_downloads: Dict[str, Dict[str, Any]] = {}

def validate_external_url(url: str):
    """
    CYB-01: SSRF and Local File Inclusion (LFI) Validator.
    Ensures URL uses http/https and does not resolve to private, loopback, or cloud metadata IPs.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("Invalid protocol: Only HTTP and HTTPS URLs are permitted.")

    hostname = parsed.hostname
    if not hostname:
        raise ValueError("Invalid URL: Missing hostname.")

    # Block known cloud metadata hostnames directly
    if hostname.lower() in ("169.254.169.254", "metadata.google.internal", "instance-data"):
        raise ValueError("Access to cloud metadata services is strictly forbidden.")

    try:
        addr_info = socket.getaddrinfo(hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror:
        raise ValueError(f"Could not resolve hostname: {hostname}")

    for family, _, _, _, sockaddr in addr_info:
        ip = ipaddress.ip_address(sockaddr[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved:
            raise ValueError(f"Security Alert: Destination IP {ip} is in a restricted or private network range.")

def check_disk_space(required_bytes: int):
    """OPS-03: Pre-download disk space guard."""
    usage = shutil.disk_usage(settings.videos_dir)
    available = usage.free - settings.MIN_FREE_DISK_BYTES
    if required_bytes > 0 and required_bytes > available:
        raise RuntimeError(
            f"Insufficient storage: requires {format_bytes(required_bytes)}, but only {format_bytes(max(0, available))} available."
        )

def format_bytes(bytes_count: int) -> str:
    """Format bytes into human-readable string."""
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
    if pct >= 100.0 or (total_bytes > 0 and downloaded_bytes >= total_bytes):
        pct = 100.0
        if status == "DOWNLOADING":
            status = "DOWNLOAD_COMPLETE"

    if status in ("DOWNLOAD_COMPLETE", "DONE", "LOCAL_READY"):
        pct = 100.0
        speed_bytes_sec = 0.0

    speed_mbs = round(speed_bytes_sec / (1024 * 1024), 2)
    remaining_bytes = max(0, total_bytes - downloaded_bytes) if status not in ("DOWNLOAD_COMPLETE", "DONE", "LOCAL_READY") else 0
    eta_sec = int(remaining_bytes / speed_bytes_sec) if speed_bytes_sec > 0 and status not in ("DOWNLOAD_COMPLETE", "DONE", "LOCAL_READY") else 0

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
    Uses concurrency lock and temporary .part file to ensure file integrity.
    """
    video = await get_video(video_id)
    if not video or not video.get("drive_file_id"):
        return

    # CODE-01: Concurrency guard to prevent duplicate simultaneous jobs
    async with _download_lock:
        if video_id in active_downloads:
            print(f"[Downloader] Video {video_id} is already downloading.")
            return
        active_downloads[video_id] = {"percentage": 0, "status": "DOWNLOADING"}

    drive_file_id = video["drive_file_id"]
    title = video.get("title", f"Video {video_id}")
    dest_path = settings.videos_dir / f"{video_id}.mp4"
    part_path = settings.videos_dir / f"{video_id}.mp4.part"

    if dest_path.exists() and video.get("status") == "LOCAL_READY":
        active_downloads.pop(video_id, None)
        return

    await update_video(video_id, {"status": "DOWNLOADING"})
    
    try:
        # Pre-check disk space if size known
        expected_size = int(video.get("file_size_bytes") or 0)
        check_disk_space(expected_size)

        url, auth_headers = drive_catalog.get_drive_download_params(drive_file_id)

        async with httpx.AsyncClient(timeout=None, follow_redirects=True) as client:
            async with client.stream("GET", url, headers=auth_headers) as response:
                if response.status_code != 200:
                    err_bytes = await response.aread()
                    try:
                        err_json = json.loads(err_bytes.decode('utf-8'))
                        msg = err_json.get("error", {}).get("message", f"HTTP {response.status_code}")
                    except Exception:
                        msg = err_bytes.decode('utf-8', errors='ignore')[:300] or f"HTTP {response.status_code}"
                    raise RuntimeError(f"Google Drive returned HTTP {response.status_code}: {msg}")

                total_bytes = int(response.headers.get("Content-Length") or expected_size)
                check_disk_space(total_bytes)

                downloaded_bytes = 0
                start_time = time.time()
                last_time = start_time
                last_bytes = 0

                # Write to .part temporary file first (OPS-03)
                with open(part_path, "wb") as f:
                    async for chunk in response.aiter_bytes(chunk_size=1024 * 1024):
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

        # Atomic rename once complete
        if part_path.exists():
            if dest_path.exists():
                os.remove(dest_path)
            part_path.rename(dest_path)

        # Update local file status in DB
        await update_video(video_id, {
            "status": "PROCESSING",
            "local_path": str(dest_path),
            "file_size_bytes": downloaded_bytes
        })

        await broadcast_progress(
            video_id=video_id,
            title=title,
            source="Google Drive (On-Demand)",
            downloaded_bytes=downloaded_bytes,
            total_bytes=downloaded_bytes,
            speed_bytes_sec=0,
            status="DOWNLOAD_COMPLETE"
        )

        from ffmpeg_worker import process_video_background
        asyncio.create_task(process_video_background(video_id))

    except Exception as e:
        print(f"[Downloader] Error downloading Drive video {video_id}: {e}")
        # Clean up stale partial files (OPS-03)
        if part_path.exists():
            try:
                os.remove(part_path)
            except OSError:
                pass

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
        active_downloads.pop(video_id, None)

async def download_external_url(video_id: str, url: str):
    """
    Downloads media from external link with SSRF protection, concurrency guard, and disk safety.
    """
    video = await get_video(video_id)
    title = video.get("title", "External URL Video")
    dest_path = settings.videos_dir / f"{video_id}.mp4"
    part_path = settings.videos_dir / f"{video_id}.mp4.part"

    # Concurrency guard
    async with _download_lock:
        if video_id in active_downloads:
            return
        active_downloads[video_id] = {"percentage": 0, "status": "DOWNLOADING"}

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
        # Validate URL for SSRF before passing to yt-dlp
        validate_external_url(url)

        ydl_opts = {
            'outtmpl': str(part_path),
            'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            'progress_hooks': [ytdl_progress_hook],
            'quiet': True,
            'no_warnings': True,
            'overwrites': True,
            'socket_timeout': 30
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            return info

    try:
        info = await asyncio.to_thread(run_ytdl)
        actual_title = info.get("title") or title

        if part_path.exists():
            if dest_path.exists():
                os.remove(dest_path)
            part_path.rename(dest_path)

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
        if part_path.exists():
            try:
                os.remove(part_path)
            except OSError:
                pass

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
        active_downloads.pop(video_id, None)
