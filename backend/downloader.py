import os
import time
import json
import shutil
import socket
import ipaddress
import asyncio
import re
from urllib.parse import urlparse, unquote
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

DIRECT_MEDIA_EXTS = {".mkv", ".mp4", ".webm", ".avi", ".mov", ".m4v", ".ts", ".flv", ".3gp", ".m2ts"}

def is_direct_media_url(url: str) -> bool:
    """Detects if a URL directly points to a media file container based on path or query parameters."""
    parsed = urlparse(url)
    path = parsed.path.lower()
    for ext in DIRECT_MEDIA_EXTS:
        if path.endswith(ext):
            return True
        if f"{ext}?" in url.lower() or f"{ext}&" in url.lower():
            return True
    return False

def get_media_extension(url: str, content_type: Optional[str] = None) -> str:
    """Extracts or infers the video container extension (.mkv, .mp4, etc.) from URL or HTTP Content-Type."""
    parsed = urlparse(url)
    raw_path = unquote(parsed.path)
    suffix = Path(raw_path).suffix.lower()
    if suffix in DIRECT_MEDIA_EXTS:
        return suffix
    if content_type:
        ct = content_type.lower()
        if "matroska" in ct or "mkv" in ct:
            return ".mkv"
        if "mp4" in ct:
            return ".mp4"
        if "webm" in ct:
            return ".webm"
        if "quicktime" in ct or "mov" in ct:
            return ".mov"
        if "x-msvideo" in ct or "avi" in ct:
            return ".avi"
    return ".mp4"

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

async def download_direct_http_stream(video_id: str, url: str):
    """
    Direct chunked streaming media downloader with HTTP Range resume support,
    live WebSocket progress, and exponential retry for CDN/media links.
    Avoids generic webpage extraction errors and 500 server errors on direct video files.
    """
    video = await get_video(video_id)
    raw_title = video.get("title") if video else None

    parsed = urlparse(url)
    raw_filename = unquote(parsed.path.split("/")[-1]) if parsed.path else ""
    ext = get_media_extension(url)
    stem_title = Path(raw_filename).stem if raw_filename else f"Video {video_id}"

    # If title is missing or default placeholder, use extracted stem
    if not raw_title or raw_title in ("External Video", "External URL Video", "Video"):
        title = stem_title
    else:
        title = raw_title

    dest_path = settings.videos_dir / f"{video_id}{ext}"
    part_path = settings.videos_dir / f"{video_id}{ext}.part"

    if dest_path.exists() and video and video.get("status") == "LOCAL_READY":
        active_downloads.pop(video_id, None)
        return

    await update_video(video_id, {"status": "DOWNLOADING", "title": title})

    max_retries = 5
    base_backoff = 2.0
    downloaded_bytes = 0
    total_bytes = int(video.get("file_size_bytes") or 0) if video else 0

    base_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "*/*",
        "Accept-Encoding": "identity",
        "Connection": "keep-alive",
    }

    last_time = time.time()
    last_bytes = 0

    for attempt in range(1, max_retries + 1):
        try:
            req_headers = dict(base_headers)
            existing_bytes = part_path.stat().st_size if part_path.exists() else 0
            if existing_bytes > 0:
                req_headers["Range"] = f"bytes={existing_bytes}-"
                file_mode = "ab"
                downloaded_bytes = existing_bytes
            else:
                file_mode = "wb"
                downloaded_bytes = 0

            # 30s connection timeout, None read timeout for continuous large media streams
            timeout = httpx.Timeout(connect=25.0, read=None, write=30.0, pool=30.0)
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
                async with client.stream("GET", url, headers=req_headers) as response:
                    # If 416 Range Not Satisfiable, server may have changed or does not accept range
                    if response.status_code == 416:
                        if part_path.exists():
                            try:
                                os.remove(part_path)
                            except OSError:
                                pass
                        existing_bytes = 0
                        downloaded_bytes = 0
                        file_mode = "wb"
                        req_headers.pop("Range", None)
                        raise httpx.HTTPStatusError("HTTP 416 Range Not Satisfiable, resetting range", request=response.request, response=response)

                    # Intermittent server errors from CDN origins
                    if response.status_code in (500, 502, 503, 504):
                        raise httpx.HTTPStatusError(f"HTTP {response.status_code} Server Error", request=response.request, response=response)

                    if response.status_code not in (200, 206):
                        err_text = await response.aread()
                        msg = err_text.decode("utf-8", errors="ignore")[:300] or f"HTTP {response.status_code}"
                        raise RuntimeError(f"Remote server returned HTTP {response.status_code}: {msg}")

                    # Validate that response is actual media and not an HTML landing/error page
                    ct = response.headers.get("content-type", "").lower()
                    if ct.startswith("text/html"):
                        if "gofile.io" in url:
                            raise ValueError(
                                "Gofile web links require JavaScript execution and an interactive browser session to unlock the direct stream token. Please provide a direct CDN stream link or public video URL."
                            )
                        raise ValueError(
                            f"The provided link returned an HTML webpage ({ct}) instead of a video stream. Please ensure the URL points directly to media content."
                        )

                    # Detect true extension from Content-Type if initial was generic
                    if ext == ".mp4" and ct:
                        true_ext = get_media_extension(url, content_type=ct)
                        if true_ext != ext:
                            ext = true_ext
                            dest_path = settings.videos_dir / f"{video_id}{ext}"
                            new_part_path = settings.videos_dir / f"{video_id}{ext}.part"
                            if part_path.exists() and part_path != new_part_path:
                                part_path.rename(new_part_path)
                            part_path = new_part_path

                    # Check Content-Disposition for filename
                    cd = response.headers.get("content-disposition", "")
                    if cd and (not raw_title or raw_title in ("External Video", "External URL Video", "Video")):
                        fn_match = re.search(r'filename\*?=(?:UTF-8\'\')?["\']?([^"\';]+)["\']?', cd, re.I)
                        if fn_match:
                            extracted_fn = unquote(fn_match.group(1).strip())
                            if extracted_fn:
                                title = Path(extracted_fn).stem

                    # Total bytes calculation
                    if response.status_code == 206:
                        cr = response.headers.get("content-range", "")
                        if cr and "/" in cr:
                            try:
                                total_bytes = int(cr.split("/")[-1])
                            except ValueError:
                                total_bytes = existing_bytes + int(response.headers.get("content-length") or 0)
                        else:
                            total_bytes = existing_bytes + int(response.headers.get("content-length") or 0)
                    else:  # 200 OK
                        total_bytes = int(response.headers.get("content-length") or 0)
                        if existing_bytes > 0 and file_mode == "ab":
                            file_mode = "wb"
                            downloaded_bytes = 0

                    if total_bytes > 0:
                        check_disk_space(total_bytes - downloaded_bytes)

                    last_time = time.time()
                    last_bytes = downloaded_bytes

                    with open(part_path, file_mode) as f:
                        async for chunk in response.aiter_bytes(chunk_size=2 * 1024 * 1024):
                            f.write(chunk)
                            downloaded_bytes += len(chunk)

                            now = time.time()
                            time_diff = now - last_time
                            if time_diff >= 0.5 or (total_bytes and downloaded_bytes >= total_bytes):
                                speed = (downloaded_bytes - last_bytes) / time_diff if time_diff > 0 else 0
                                await broadcast_progress(
                                    video_id=video_id,
                                    title=title,
                                    source="Direct Stream",
                                    downloaded_bytes=downloaded_bytes,
                                    total_bytes=total_bytes or downloaded_bytes,
                                    speed_bytes_sec=speed,
                                    status="DOWNLOADING"
                                )
                                last_time = now
                                last_bytes = downloaded_bytes

            # Streaming completed successfully for this response
            break

        except (httpx.HTTPStatusError, httpx.RequestError, asyncio.TimeoutError) as e:
            is_server_error = False
            status_code = getattr(getattr(e, "response", None), "status_code", None)
            if status_code in (500, 502, 503, 504, 416) or isinstance(e, (httpx.ConnectTimeout, httpx.ReadTimeout, httpx.RemoteProtocolError, httpx.ConnectError)):
                is_server_error = True

            if attempt < max_retries and is_server_error:
                backoff = base_backoff * (2 ** (attempt - 1))
                print(f"[Downloader] Stream attempt {attempt}/{max_retries} encountered {e}. Retrying in {backoff}s...")
                await broadcast_progress(
                    video_id=video_id,
                    title=title,
                    source="Direct Stream",
                    downloaded_bytes=downloaded_bytes,
                    total_bytes=total_bytes,
                    speed_bytes_sec=0,
                    status="DOWNLOADING",
                    error_message=f"Server returned {e}. Retrying in {int(backoff)}s (attempt {attempt}/{max_retries})..."
                )
                await asyncio.sleep(backoff)
                continue
            else:
                raise RuntimeError(f"Direct stream download failed after {attempt} attempts: {e}")

    # Finalize download: Atomic rename
    if part_path.exists():
        if dest_path.exists():
            os.remove(dest_path)
        part_path.rename(dest_path)

    final_size = dest_path.stat().st_size if dest_path.exists() else downloaded_bytes

    await update_video(video_id, {
        "title": title,
        "status": "PROCESSING",
        "local_path": str(dest_path),
        "file_size_bytes": final_size
    })

    await broadcast_progress(
        video_id=video_id,
        title=title,
        source="Direct Stream",
        downloaded_bytes=final_size,
        total_bytes=final_size,
        speed_bytes_sec=0,
        status="DOWNLOAD_COMPLETE"
    )

    from ffmpeg_worker import process_video_background
    asyncio.create_task(process_video_background(video_id))


async def download_via_ytdl(video_id: str, url: str):
    """Downloads web platform video (YouTube, Vimeo, etc.) via yt-dlp."""
    video = await get_video(video_id)
    title = video.get("title", "External URL Video")
    dest_path = settings.videos_dir / f"{video_id}.mp4"
    part_path = settings.videos_dir / f"{video_id}.mp4.part"

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
        cookie_candidates = [
            Path(settings.STORAGE_DIR) / "cookies.txt",
            Path(__file__).parent / "cookies.txt",
            Path(__file__).parent.parent / "cookies.txt"
        ]
        cookie_file = next((p for p in cookie_candidates if p.exists()), None)

        ydl_opts = {
            'outtmpl': str(part_path),
            'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            'progress_hooks': [ytdl_progress_hook],
            'quiet': True,
            'no_warnings': True,
            'overwrites': True,
            'socket_timeout': 30,
            'extractor_args': {
                'youtube': {
                    'player_client': ['android', 'web', 'mweb'],
                }
            },
            'http_headers': {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            }
        }
        if cookie_file:
            ydl_opts['cookiefile'] = str(cookie_file)

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            return info

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


async def download_external_url(video_id: str, url: str):
    """
    Downloads media from external link with SSRF protection, concurrency guard, and disk safety.
    Routes direct media files (.mkv, .mp4, etc.) to high-speed chunked stream downloader with resume and retry,
    and video platforms (YouTube, etc.) to yt-dlp with automatic fallback.
    """
    video = await get_video(video_id)
    title = video.get("title", "External URL Video") if video else "External URL Video"

    # Concurrency guard
    async with _download_lock:
        if video_id in active_downloads:
            return
        active_downloads[video_id] = {"percentage": 0, "status": "DOWNLOADING"}

    try:
        # Validate URL for SSRF before any network operations
        validate_external_url(url)

        # Explicit warning if a raw Google Video stream chunk is submitted
        if ("googlevideo.com" in url and "videoplayback" in url) or ("&sig=" in url and "itag=" in url and "googlevideo" in url):
            raise ValueError(
                "Direct Google Video CDN stream chunks (googlevideo.com/videoplayback) are cryptographically IP-bound to your personal browser and rejected with HTTP 403 Forbidden by Google servers. Please provide the public YouTube link (https://www.youtube.com/watch?v=... or https://youtu.be/...) instead."
            )

        # Explicit warning if Gofile interactive session link is submitted
        if "gofile.io" in url and ("/download/web/" in url or "/d/" in url):
            raise ValueError(
                "Gofile links require an interactive browser session with JavaScript verification (wt.obf.js) to generate a temporary token and cannot be streamed server-to-server. Please open the link in your browser to download it, or use a direct media link (e.g., from mkvcdn, direct CDN, or Google Drive)."
            )

        if is_direct_media_url(url):
            await download_direct_http_stream(video_id, url)
        else:
            try:
                await download_via_ytdl(video_id, url)
            except Exception as ytdl_err:
                err_str = str(ytdl_err)
                # If yt-dlp failed due to 500 or generic extractor error, attempt direct HTTP streaming fallback
                if any(x in err_str.lower() for x in ["500", "502", "503", "504", "generic", "extractorerror", "expected string or bytes-like object"]):
                    print(f"[Downloader] yt-dlp failed ({err_str}), falling back to direct HTTP stream...")
                    await download_direct_http_stream(video_id, url)
                else:
                    raise ytdl_err

    except Exception as e:
        err_msg = str(e)
        if ("googlevideo.com" in url or "videoplayback" in url) and ("403" in err_msg or "Forbidden" in err_msg):
            err_msg = "Google Video CDN stream rejected (HTTP 403 Forbidden: IP-locked to your browser). Please paste the public YouTube URL (https://www.youtube.com/watch?v=...) instead of the raw stream chunk."
        print(f"[Downloader] Error downloading {video_id}: {err_msg}")

        # Clean up any partial files
        for p in settings.videos_dir.glob(f"{video_id}.*"):
            if p.name.endswith(".part"):
                try:
                    os.remove(p)
                except OSError:
                    pass

        await update_video(video_id, {"status": "FAILED", "error": err_msg})
        await broadcast_progress(
            video_id=video_id,
            title=title,
            source="External URL",
            downloaded_bytes=0,
            total_bytes=0,
            speed_bytes_sec=0,
            status="FAILED",
            error_message=err_msg
        )
        active_downloads.pop(video_id, None)
