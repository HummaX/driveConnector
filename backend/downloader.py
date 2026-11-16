import os
import time
import json
import shutil
import socket
import ipaddress
import asyncio
import contextvars
import uuid
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

# Worker mode keeps the ingestion pipeline inside its leased job.
worker_inline_processing = contextvars.ContextVar("worker_inline_processing", default=False)

async def schedule_processing(video_id):
    from ffmpeg_worker import process_video_background
    if worker_inline_processing.get():
        await process_video_background(video_id)
    else:
        asyncio.create_task(process_video_background(video_id))


def finalize_download(part_path: Path, dest_path: Path):
    """Publish a completed transfer without replacing any existing file."""
    os.link(part_path, dest_path)
    part_path.unlink()
    # A local receipt bridges publication -> MongoDB metadata failure.
    stat = dest_path.stat()
    receipt = dest_path.with_name(dest_path.name + ".verified")
    with receipt.open("x", encoding="utf-8") as stream:
        json.dump({"size": stat.st_size, "mtime_ns": stat.st_mtime_ns}, stream)
        stream.flush()
        os.fsync(stream.fileno())


async def resume_verified_download(video_id, video):
    """Resume metadata on published bytes; never redownload over local sources."""
    if not video:
        return False
    paths = []
    if video.get("local_path"):
        paths.append(Path(video["local_path"]))
    paths.extend(p for p in settings.videos_dir.glob(f"{video_id}.*") if p.suffix.lower() in DIRECT_MEDIA_EXTS)
    source = next((p for p in paths if p.is_file()), None)
    if source is None:
        return False
    try:
        receipt = json.loads(source.with_name(source.name + ".verified").read_text(encoding="utf-8"))
        stat = source.stat()
        verified = stat.st_size > 0 and receipt == {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns}
    except (OSError, ValueError, TypeError):
        verified = bool(video.get("download_verified") and source.stat().st_size > 0
                        and source.stat().st_size == video.get("file_size_bytes"))
    if not verified:
        raise RuntimeError("Existing local source is unverified; inspect explicitly, refusing redownload")
    if video.get("status") != "LOCAL_READY" or not video.get("local_path"):
        await update_video(video_id, {"status": "PROCESSING", "local_path": str(source),
                                     "file_size_bytes": source.stat().st_size, "download_verified": True})
        await schedule_processing(video_id)
    return True


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
        # API relays must not republish the same event into durable storage.
        # Only the isolated job process is the durable event producer.
        if worker_inline_processing.get():
            import job_events
            await job_events.publish(message)
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

BLOCKED_IP_NETWORKS = [
    # IPv4 loopback, private, carrier-grade, and reserved ranges
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.0.0.0/24"),
    ipaddress.ip_network("192.0.2.0/24"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("198.18.0.0/15"),
    ipaddress.ip_network("198.51.100.0/24"),
    ipaddress.ip_network("203.0.113.0/24"),
    ipaddress.ip_network("224.0.0.0/4"),
    ipaddress.ip_network("240.0.0.0/4"),
    ipaddress.ip_network("255.255.255.255/32"),
    # IPv6 loopback, unspecified, unique local (fc00::/7), link-local (fe80::/10), multicast, docs
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("::/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
    ipaddress.ip_network("ff00::/8"),
    ipaddress.ip_network("2001:db8::/32"),
]

def is_ip_restricted(ip_obj: ipaddress._BaseAddress) -> bool:
    """Checks if an IP address falls into private, loopback, link-local, multicast or reserved ranges."""
    if ip_obj.is_private or ip_obj.is_loopback or ip_obj.is_link_local or ip_obj.is_multicast or ip_obj.is_reserved or ip_obj.is_unspecified:
        return True
    if isinstance(ip_obj, ipaddress.IPv6Address):
        if ip_obj.ipv4_mapped and is_ip_restricted(ip_obj.ipv4_mapped):
            return True
        if ip_obj.sixtofour and is_ip_restricted(ip_obj.sixtofour):
            return True
        if ip_obj.teredo:
            server, client = ip_obj.teredo
            if is_ip_restricted(server) or is_ip_restricted(client):
                return True
    for net in BLOCKED_IP_NETWORKS:
        if ip_obj in net:
            return True
    return False

def validate_external_url(url: str):
    """
    CYB-01: SSRF, IPv6 and DNS Rebinding Protection.
    Ensures URL uses http/https, blocks private/reserved IPv4, blocks ::1, fc00::/7, fe80::/10,
    and defends against DNS rebinding by resolving all IPv4/IPv6 records before download.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("Invalid protocol: Only HTTP and HTTPS URLs are permitted.")

    hostname = parsed.hostname
    if not hostname:
        raise ValueError("Invalid URL: Missing hostname.")

    hostname_clean = hostname.strip().lower().strip("[]")

    # Block direct metadata / local hostnames
    if hostname_clean in ("localhost", "127.0.0.1", "::1", "169.254.169.254", "metadata.google.internal", "instance-data"):
        raise ValueError("Access to loopback or cloud metadata services is strictly forbidden.")

    if hostname_clean.endswith(".localhost") or hostname_clean.endswith(".local") or hostname_clean.endswith(".internal"):
        raise ValueError(f"Access to internal domain {hostname} is strictly forbidden.")

    # Check if hostname itself is an IP literal
    try:
        direct_ip = ipaddress.ip_address(hostname_clean)
        if is_ip_restricted(direct_ip):
            raise ValueError(f"Security Alert: Destination IP {direct_ip} is in a restricted or private network range.")
    except ValueError as ve:
        if "Security Alert" in str(ve):
            raise
        # Not an IP literal, will resolve via DNS

    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        # Resolve all addresses (dual-stack: AF_UNSPEC) to prevent DNS rebinding or dual-stack SSRF bypass
        addr_info = socket.getaddrinfo(hostname_clean, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise ValueError(f"Could not resolve hostname: {hostname}")

    if not addr_info:
        raise ValueError(f"No address records found for hostname: {hostname}")

    for _, _, _, _, sockaddr in addr_info:
        raw_ip = sockaddr[0]
        if "%" in raw_ip:  # IPv6 scope ID
            raw_ip = raw_ip.split("%")[0]
        ip = ipaddress.ip_address(raw_ip)
        if is_ip_restricted(ip):
            raise ValueError(f"Security Alert: Destination IP {ip} is in a restricted or private network range.")

def get_rclone_config_path() -> Optional[Path]:
    """Checks standard locations for rclone.conf."""
    candidates = [
        Path(settings.STORAGE_DIR) / "rclone.conf",
        Path(settings.STORAGE_DIR) / "rclone" / "rclone.conf",
        Path(__file__).parent / "rclone.conf",
        Path.home() / ".config" / "rclone" / "rclone.conf",
        Path("/etc/rclone/rclone.conf"),
    ]
    for p in candidates:
        if p.exists() and p.is_file():
            return p
    return None

async def try_download_drive_via_rclone(
    video_id: str,
    title: str,
    url: str,
    auth_headers: Dict[str, str],
    part_path: Path,
    expected_size: int
) -> bool:
    """
    Accelerated multi-stream rclone download (--multi-thread-streams 8 --buffer-size 64M).
    Falls back cleanly if rclone is unavailable or returns an error.
    """
    rclone_bin = shutil.which("rclone")
    if not rclone_bin:
        return False

    rclone_conf = get_rclone_config_path()
    cmd = [
        rclone_bin,
        "copyurl",
        url,
        str(part_path),
        "--multi-thread-streams", "8",
        "--buffer-size", "64M",
        "--retries", "3",
        "--low-level-retries", "5",
        "--stats", "1s",
    ]
    if rclone_conf:
        cmd.extend(["--config", str(rclone_conf)])
    for k, v in auth_headers.items():
        cmd.extend(["--header", f"{k}: {v}"])

    print(f"[Downloader] Attempting multi-stream rclone download for {video_id} (--multi-thread-streams 8 --buffer-size 64M)...")
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        communicate_task = asyncio.create_task(proc.communicate())
        last_time = time.time()
        last_bytes = 0
        deadline = time.monotonic() + 7200
        while not communicate_task.done():
            if time.monotonic() >= deadline:
                raise TimeoutError("Transfer subprocess timed out")
            await asyncio.sleep(0.5)
            if proc.returncode is not None:
                break
            if part_path.exists():
                cur_size = part_path.stat().st_size
                now = time.time()
                dt = now - last_time
                if dt >= 0.5:
                    speed = (cur_size - last_bytes) / dt if dt > 0 else 0
                    await broadcast_progress(
                        video_id=video_id,
                        title=title,
                        source="Google Drive (rclone multi-stream)",
                        downloaded_bytes=cur_size,
                        total_bytes=expected_size,
                        speed_bytes_sec=speed,
                        status="DOWNLOADING", transfer_verified=False
                    )
                    last_time = now
                    last_bytes = cur_size

        stdout, stderr = await communicate_task
        if proc.returncode == 0 and part_path.exists() and part_path.stat().st_size > 0:
            print(f"[Downloader] rclone multi-stream completed successfully for {video_id}")
            return True
        else:
            err_msg = stderr.decode("utf-8", errors="ignore")[:300]
            print(f"[Downloader] rclone exited with code {proc.returncode}: {err_msg}. Falling back to httpx stream.")
            if part_path.exists():
                try:
                    os.remove(part_path)
                except OSError:
                    pass
            return False
    except asyncio.CancelledError:
        if 'proc' in locals() and proc.returncode is None:
            proc.kill()
            await proc.wait()
        if 'communicate_task' in locals():
            await asyncio.gather(communicate_task, return_exceptions=True)
        raise
    except Exception as e:
        if 'proc' in locals() and proc.returncode is None:
            proc.kill()
            await proc.wait()
        if 'communicate_task' in locals():
            await asyncio.gather(communicate_task, return_exceptions=True)
        print(f"[Downloader] rclone execution failed: {e}. Falling back to httpx stream.")
        if part_path.exists():
            try:
                os.remove(part_path)
            except OSError:
                pass
        return False

async def try_download_direct_via_aria2(
    video_id: str,
    url: str,
    title: str,
    part_path: Path,
    expected_size: int = 0
) -> bool:
    """
    Accelerated multi-connection aria2c download (-x 16 -s 16 -k 1M).
    Falls back cleanly if aria2c is unavailable or returns an error.
    """
    aria2_bin = shutil.which("aria2c")
    if not aria2_bin:
        return False

    out_filename = part_path.name
    out_dir = str(part_path.parent)

    cmd = [
        aria2_bin,
        "-x", "16",
        "-s", "16",
        "-k", "1M",
        "--dir", out_dir,
        "--out", out_filename,
        "--allow-overwrite=true",
        "--auto-file-renaming=false",
        "--summary-interval=1",
        "--file-allocation=none",
        "--max-tries=3",
        "--retry-wait=2",
        "--timeout=30",
        "--header=User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        url
    ]

    print(f"[Downloader] Attempting multi-connection aria2c download for {video_id} (-x 16 -s 16 -k 1M): {url}")
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        communicate_task = asyncio.create_task(proc.communicate())
        last_time = time.time()
        last_bytes = 0

        deadline = time.monotonic() + 7200
        while not communicate_task.done():
            if time.monotonic() >= deadline:
                raise TimeoutError("Transfer subprocess timed out")
            await asyncio.sleep(0.5)
            if proc.returncode is not None:
                break
            if part_path.exists():
                cur_size = part_path.stat().st_size
                now = time.time()
                dt = now - last_time
                if dt >= 0.5:
                    speed = (cur_size - last_bytes) / dt if dt > 0 else 0
                    await broadcast_progress(
                        video_id=video_id,
                        title=title,
                        source="Direct Media (aria2c multi-connection)",
                        downloaded_bytes=cur_size,
                        total_bytes=expected_size,
                        speed_bytes_sec=speed,
                        status="DOWNLOADING", transfer_verified=False
                    )
                    last_time = now
                    last_bytes = cur_size

        stdout, stderr = await communicate_task

        control_file = part_path.parent / f"{out_filename}.aria2"
        if control_file.exists():
            try:
                os.remove(control_file)
            except OSError:
                pass

        if proc.returncode == 0 and part_path.exists() and part_path.stat().st_size > 0:
            print(f"[Downloader] aria2c download succeeded for {video_id} ({format_bytes(part_path.stat().st_size)})")
            return True
        else:
            err_msg = stderr.decode("utf-8", errors="ignore")[:300]
            print(f"[Downloader] aria2c exited with code {proc.returncode}: {err_msg}. Falling back to httpx stream.")
            if part_path.exists():
                try:
                    os.remove(part_path)
                except OSError:
                    pass
            return False
    except asyncio.CancelledError:
        if 'proc' in locals() and proc.returncode is None:
            proc.kill()
            await proc.wait()
        if 'communicate_task' in locals():
            await asyncio.gather(communicate_task, return_exceptions=True)
        raise
    except Exception as e:
        if 'proc' in locals() and proc.returncode is None:
            proc.kill()
            await proc.wait()
        if 'communicate_task' in locals():
            await asyncio.gather(communicate_task, return_exceptions=True)
        print(f"[Downloader] aria2c execution failed: {e}. Falling back to httpx stream.")
        control_file = part_path.parent / f"{out_filename}.aria2"
        if control_file.exists():
            try:
                os.remove(control_file)
            except OSError:
                pass
        if part_path.exists():
            try:
                os.remove(part_path)
            except OSError:
                pass
        return False

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

JDOWNLOADER_HOSTERS = [
    "gofile.io",
    "mega.nz",
    "mega.co.nz",
    "1fichier.com",
    "rapidgator.net",
    "mediafire.com",
    "terabox.com",
    "teraboxapp.com",
    "1024tera.com",
    "pixeldrain.com",
    "nitroflare.com",
    "katfile.com",
    "turbobit.net",
    "filerio.in",
    "dropgalaxy.com",
    "uploadhaven.com",
    "upstore.net",
    "ddownload.com",
    "streamtape.com",
    "voe.sx",
    "mixdrop.co",
    "doodstream.com",
    "krakenfiles.com",
    "filefactory.com",
    "uptobox.com",
    "send.cm",
    "buzzheavier.com"
]

def is_jdownloader_hoster(url: str) -> bool:
    """Detects if a URL is hosted on a cyberlocker/file hoster requiring JDownloader 2 decrypter plugins."""
    try:
        parsed = urlparse(url)
        hostname = (parsed.hostname or "").lower()
        return any(h in hostname for h in JDOWNLOADER_HOSTERS)
    except Exception:
        return False

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
    error_message: Optional[str] = None,
    transfer_verified: bool = True
):
    """Calculates telemetry metrics and broadcasts JSON payload to all connected WebSockets."""
    pct = round((downloaded_bytes / total_bytes * 100), 1) if total_bytes > 0 else 0.0
    # Preserve the legacy public function contract; internal progress reports
    # explicitly mark unverified transfers so size alone never signals success.
    if status == "DOWNLOADING" and transfer_verified and total_bytes > 0 and downloaded_bytes >= total_bytes:
        status = "DOWNLOAD_COMPLETE"
    elif status == "DOWNLOADING" and total_bytes > 0 and downloaded_bytes >= total_bytes:
        status = "FINALIZING"

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

    if await resume_verified_download(video_id, video):
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
    part_path = settings.videos_dir / f"{video_id}.{uuid.uuid4().hex}.mp4.part"

    if dest_path.exists() and video.get("status") == "LOCAL_READY":
        active_downloads.pop(video_id, None)
        return

    await update_video(video_id, {"status": "DOWNLOADING"})
    
    try:
        # Pre-check disk space if size known
        expected_size = int(video.get("file_size_bytes") or 0)
        check_disk_space(expected_size)

        url, auth_headers = drive_catalog.get_drive_download_params(drive_file_id)

        # Multi-stream rclone acceleration with fallback to httpx streaming
        rclone_downloaded = False
        if shutil.which("rclone"):
            rclone_downloaded = await try_download_drive_via_rclone(
                video_id=video_id,
                title=title,
                url=url,
                auth_headers=auth_headers,
                part_path=part_path,
                expected_size=expected_size
            )

        if rclone_downloaded and part_path.exists():
            downloaded_bytes = part_path.stat().st_size
        else:
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
                    expected_size = total_bytes
                    check_disk_space(total_bytes)

                    downloaded_bytes = 0
                    start_time = time.time()
                    last_time = start_time
                    last_bytes = 0

                    # Write to .part temporary file first (OPS-03)
                    with open(part_path, "wb") as f:
                        async for chunk in response.aiter_bytes(chunk_size=settings.DOWNLOAD_CHUNK_SIZE_BYTES):
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
                                    status="DOWNLOADING", transfer_verified=False
                                )
                                last_time = now
                                last_bytes = downloaded_bytes

        # Never overwrite a pre-existing file; require a complete transfer.
        if not part_path.is_file() or downloaded_bytes <= 0 or (expected_size and downloaded_bytes != expected_size):
            raise RuntimeError("Incomplete Drive transfer")
        if dest_path.exists():
            raise FileExistsError("Destination already exists")
        finalize_download(part_path, dest_path)

        # Update local file status in DB
        await update_video(video_id, {
            "status": "PROCESSING",
            "local_path": str(dest_path),
            "file_size_bytes": downloaded_bytes, "download_verified": True
        })

        await broadcast_progress(
            video_id=video_id,
            title=title,
            source="Google Drive (On-Demand)",
            downloaded_bytes=downloaded_bytes,
            total_bytes=downloaded_bytes,
            speed_bytes_sec=0,
            status="DOWNLOAD_COMPLETE", transfer_verified=True
        )

        await schedule_processing(video_id)

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
            status="FAILED", transfer_verified=False,
            error_message=str(e)
        )
        active_downloads.pop(video_id, None)
        if worker_inline_processing.get():
            raise

async def download_direct_http_stream(video_id: str, url: str):
    """
    Direct chunked streaming media downloader with HTTP Range resume support,
    live WebSocket progress, and exponential retry for CDN/media links.
    Avoids generic webpage extraction errors and 500 server errors on direct video files.
    """
    video = await get_video(video_id)
    if await resume_verified_download(video_id, video):
        return
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
    part_path = settings.videos_dir / f"{video_id}.{uuid.uuid4().hex}{ext}.part"

    if dest_path.exists() and video and video.get("status") == "LOCAL_READY":
        active_downloads.pop(video_id, None)
        return

    await update_video(video_id, {"status": "DOWNLOADING", "title": title})

    total_bytes = int(video.get("file_size_bytes") or 0) if video else 0

    # High-speed multi-connection aria2c integration (-x 16 -s 16 -k 1M)
    if shutil.which("aria2c"):
        aria2_ok = await try_download_direct_via_aria2(
            video_id=video_id,
            url=url,
            title=title,
            part_path=part_path,
            expected_size=total_bytes
        )
        if aria2_ok:
            if not part_path.is_file() or part_path.stat().st_size <= 0 or (total_bytes and part_path.stat().st_size != total_bytes):
                raise RuntimeError("Incomplete aria2 transfer")
            if dest_path.exists():
                raise FileExistsError("Destination already exists")
            finalize_download(part_path, dest_path)

            final_size = dest_path.stat().st_size if dest_path.exists() else 0
            await update_video(video_id, {
                "title": title,
                "status": "PROCESSING",
                "local_path": str(dest_path),
                "file_size_bytes": final_size, "download_verified": True
            })
            await broadcast_progress(
                video_id=video_id,
                title=title,
                source="Direct Stream",
                downloaded_bytes=final_size,
                total_bytes=final_size,
                speed_bytes_sec=0,
                status="DOWNLOAD_COMPLETE", transfer_verified=True
            )
            await schedule_processing(video_id)
            return

    max_retries = 5
    base_backoff = 2.0
    downloaded_bytes = 0

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
            # Range bytes= resume requires a strong validator; restart instead.
            # Restart without a persisted strong validator rather than append
            # bytes from a potentially changed representation.
            existing_bytes = 0
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

                    if response.status_code == 206:
                        raise RuntimeError("Unexpected partial response without a validated range")
                    if response.status_code not in (200, 206):
                        err_text = await response.aread()
                        msg = err_text.decode("utf-8", errors="ignore")[:300] or f"HTTP {response.status_code}"
                        raise RuntimeError(f"Remote server returned HTTP {response.status_code}: {msg}")

                    # Validate that response is actual media and not an HTML landing/error page
                    ct = response.headers.get("content-type", "").lower()
                    if ct.startswith("text/html"):
                        if part_path.exists():
                            try:
                                os.remove(part_path)
                            except OSError:
                                pass
                        print(f"[Downloader] Link returned HTML webpage ({ct}). Auto-routing to JDownloader 2 engine...")
                        return await download_via_jdownloader(video_id, url, title)

                    # Detect true extension from Content-Type if initial was generic
                    if ext == ".mp4" and ct:
                        true_ext = get_media_extension(url, content_type=ct)
                        if true_ext != ext:
                            ext = true_ext
                            dest_path = settings.videos_dir / f"{video_id}{ext}"
                            new_part_path = settings.videos_dir / f"{video_id}.{uuid.uuid4().hex}{ext}.part"
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
                        async for chunk in response.aiter_bytes(chunk_size=settings.DOWNLOAD_CHUNK_SIZE_BYTES):
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
                                    total_bytes=total_bytes,
                                    speed_bytes_sec=speed,
                                    status="DOWNLOADING", transfer_verified=False
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
                    status="DOWNLOADING", transfer_verified=False,
                    error_message=f"Server returned {e}. Retrying in {int(backoff)}s (attempt {attempt}/{max_retries})..."
                )
                await asyncio.sleep(backoff)
                continue
            else:
                raise RuntimeError(f"Direct stream download failed after {attempt} attempts: {e}")

    # Finalize only verified, non-empty transfers and preserve existing files.
    if not part_path.is_file() or downloaded_bytes <= 0 or (total_bytes and downloaded_bytes != total_bytes):
        raise RuntimeError("Incomplete direct transfer")
    if dest_path.exists():
        raise FileExistsError("Destination already exists")
    finalize_download(part_path, dest_path)

    final_size = dest_path.stat().st_size

    await update_video(video_id, {
        "title": title,
        "status": "PROCESSING",
        "local_path": str(dest_path),
        "file_size_bytes": final_size, "download_verified": True
    })

    await broadcast_progress(
        video_id=video_id,
        title=title,
        source="Direct Stream",
        downloaded_bytes=final_size,
        total_bytes=final_size,
        speed_bytes_sec=0,
        status="DOWNLOAD_COMPLETE", transfer_verified=True
    )

    await schedule_processing(video_id)


async def download_via_ytdl(video_id: str, url: str):
    """Downloads web platform video (YouTube, Vimeo, etc.) via yt-dlp."""
    video = await get_video(video_id)
    if await resume_verified_download(video_id, video):
        return
    title = video.get("title", "External URL Video")
    dest_path = settings.videos_dir / f"{video_id}.mp4"
    part_path = settings.videos_dir / f"{video_id}.{uuid.uuid4().hex}.mp4.part"

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
                        status="DOWNLOADING", transfer_verified=False
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

    if not part_path.is_file() or part_path.stat().st_size <= 0:
        raise RuntimeError("Downloader did not produce a completed file")
    if dest_path.exists():
        raise FileExistsError("Destination already exists")
    finalize_download(part_path, dest_path)

    file_size = os.path.getsize(dest_path)

    await update_video(video_id, {
        "title": actual_title,
        "status": "PROCESSING",
        "local_path": str(dest_path),
        "file_size_bytes": file_size, "download_verified": True
    })

    await broadcast_progress(
        video_id=video_id,
        title=actual_title,
        source="External URL",
        downloaded_bytes=file_size,
        total_bytes=file_size,
        speed_bytes_sec=0,
        status="DOWNLOAD_COMPLETE", transfer_verified=True
    )

    await schedule_processing(video_id)


async def download_via_jdownloader(video_id: str, url: str, custom_title: Optional[str] = None):
    """
    Automated JDownloader 2 integration for protected file hosters (Gofile, Mega, Rapidgator, etc.).
    Writes a .crawljob into the shared folderwatch directory and monitors /output for download completion.
    """
    if worker_inline_processing.get():
        raise RuntimeError("External JDownloader cannot be isolated and verified stopped; durable dispatch disabled")
    video = await get_video(video_id)
    raw_title = custom_title or (video.get("title") if video else None)
    if not raw_title or raw_title in ("External Video", "External URL Video", "Video"):
        parsed_path = urlparse(url).path
        raw_filename = unquote(parsed_path.split("/")[-1]) if parsed_path else ""
        raw_title = Path(raw_filename).stem if raw_filename else f"Download_{video_id}"
    clean_title = (raw_title or f"Download_{video_id}").strip()

    await update_video(video_id, {
        "status": "DOWNLOADING",
        "title": clean_title,
        "source": "JDOWNLOADER"
    })

    await broadcast_progress(
        video_id=video_id,
        title=clean_title,
        source="JDownloader 2 (Auto)",
        downloaded_bytes=0,
        total_bytes=0,
        speed_bytes_sec=0,
        status="DOWNLOADING", transfer_verified=False
    )

    # 1. Ensure JDownloader directories and configuration exist
    jdownloader_dir = Path(settings.STORAGE_DIR) / "jdownloader"
    folderwatch_dir = jdownloader_dir / "folderwatch"
    cfg_dir = jdownloader_dir / "cfg"
    folderwatch_dir.mkdir(parents=True, exist_ok=True)
    cfg_dir.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(folderwatch_dir, 0o777)
    except Exception:
        pass

    # Pre-seed FolderWatch and GeneralSettings if not present
    fw_ext = cfg_dir / "org.jdownloader.extensions.folderwatch.FolderWatchExtension.json"
    if not fw_ext.exists():
        try:
            fw_ext.write_text('{\n  "enabled": true\n}\n', encoding="utf-8")
        except Exception:
            pass

    gen_cfg = cfg_dir / "org.jdownloader.settings.GeneralSettings.json"
    if not gen_cfg.exists():
        try:
            gen_cfg.write_text('{\n  "defaultdownloadfolder": "/output"\n}\n', encoding="utf-8")
        except Exception:
            pass

    # Private output prevents concurrent jobs from claiming each other's files.
    if any(c in url or c in clean_title for c in ("\n", "\r")):
        raise ValueError("Invalid JDownloader job input")
    job_name = "jd_" + uuid.uuid4().hex
    job_output = settings.videos_dir / job_name
    job_output.mkdir(parents=True, exist_ok=False)

    # 3. Create .crawljob file
    job_file = folderwatch_dir / f"job_{video_id}.crawljob"
    crawljob_content = (
        f"text={url}\n"
        f"packageName={clean_title}\n"
        f"downloadFolder=/output/{job_name}\n"
        f"autoStart=TRUE\n"
        f"autoConfirm=TRUE\n"
        f"forcedStart=TRUE\n"
        f"overwritePackagizerEnabled=true\n"
    )
    job_file.write_text(crawljob_content, encoding="utf-8")
    try:
        os.chmod(job_file, 0o666)
    except Exception:
        pass
    print(f"[JDownloader] Dispatched .crawljob for {video_id} to {job_file}")

    # 4. Monitor /output (${STORAGE_DIR}/videos) for download progress and completion
    max_wait_seconds = 7200  # Up to 2 hours
    start_time = time.time()
    discovered_file: Optional[Path] = None
    last_known_size = 0
    stable_checks = 0

    while time.time() - start_time < max_wait_seconds:
        await asyncio.sleep(4)

        try:
            current_files = [p for p in job_output.rglob("*") if p.is_file() and p.resolve().is_relative_to(job_output.resolve())]
        except Exception:
            current_files = []

        for cand in current_files:
            name_lower = cand.name.lower()
            if name_lower.endswith(".part") or name_lower.endswith(".tmp") or name_lower.endswith(".download"):
                try:
                    cur_size = cand.stat().st_size
                    speed = (cur_size - last_known_size) / 4.0 if cur_size > last_known_size else 0
                    last_known_size = cur_size
                    await broadcast_progress(
                        video_id=video_id,
                        title=clean_title,
                        source="JDownloader 2 (Downloading)",
                        downloaded_bytes=cur_size,
                        total_bytes=0,
                        speed_bytes_sec=speed,
                        status="DOWNLOADING", transfer_verified=False
                    )
                except OSError:
                    pass
                break

            cand_ext = cand.suffix.lower()
            if cand_ext in DIRECT_MEDIA_EXTS:
                try:
                    s1 = cand.stat().st_size
                    if s1 > 512 * 1024:  # At least 512 KB
                        if s1 == last_known_size:
                            stable_checks += 1
                            if stable_checks >= 2:
                                discovered_file = cand
                                break
                        else:
                            last_known_size = s1
                            stable_checks = 0
                except OSError:
                    continue

        if discovered_file:
            break

    if not discovered_file:
        await update_video(video_id, {"status": "FAILED", "error": "JDownloader download timed out or did not complete."})
        active_downloads.pop(video_id, None)
        return

    # 5. Success - register downloaded video
    final_size = discovered_file.stat().st_size
    final_title = discovered_file.stem if clean_title in ("External Video", "External URL Video", "Video") else clean_title

    await update_video(video_id, {
        "title": final_title,
        "status": "PROCESSING",
        "local_path": str(discovered_file),
        "file_size_bytes": final_size
    })

    await broadcast_progress(
        video_id=video_id,
        title=final_title,
        source="JDownloader 2",
        downloaded_bytes=final_size,
        total_bytes=final_size,
        speed_bytes_sec=0,
        status="DOWNLOAD_COMPLETE", transfer_verified=True
    )

    active_downloads.pop(video_id, None)

    # 6. Trigger FFmpeg processing (poster, hover preview, sprites)
    await schedule_processing(video_id)


async def download_external_url(video_id: str, url: str, engine: str = "auto"):
    """
    Downloads media from external link with SSRF protection, concurrency guard, and disk safety.
    Routes direct media files (.mkv, .mp4, etc.) to high-speed chunked stream downloader with resume and retry,
    cyberlockers and protected links (Gofile, Mega, Rapidgator, etc.) to JDownloader 2 automatically,
    and video platforms (YouTube, etc.) to yt-dlp with automatic fallback.
    """
    video = await get_video(video_id)
    title = video.get("title", "External URL Video") if video else "External URL Video"

    if await resume_verified_download(video_id, video):
        return

    # Concurrency guard
    async with _download_lock:
        if video_id in active_downloads:
            return
        active_downloads[video_id] = {"percentage": 0, "status": "DOWNLOADING"}

    try:
        # Validate URL for SSRF before any network operations
        validate_external_url(url)

        # Check explicit engine choice or hoster auto-detection
        clean_engine = (engine or "auto").lower().strip()
        if clean_engine == "jdownloader" or (clean_engine == "auto" and is_jdownloader_hoster(url)):
            print(f"[Downloader] Routing {url} to JDownloader 2 engine...")
            try:
                return await download_via_jdownloader(video_id, url, title)
            except Exception as jd_err:
                if worker_inline_processing.get():
                    raise
                print(f"[Downloader] JDownloader engine error: {jd_err}")
                if is_direct_media_url(url):
                    print(f"[Downloader] Falling back to direct HTTP stream for direct media URL: {url}")
                    return await download_direct_http_stream(video_id, url)
                raise jd_err

        # Explicit warning if a raw Google Video stream chunk is submitted
        if ("googlevideo.com" in url and "videoplayback" in url) or ("&sig=" in url and "itag=" in url and "googlevideo" in url):
            raise ValueError(
                "Direct Google Video CDN stream chunks (googlevideo.com/videoplayback) are cryptographically IP-bound to your personal browser and rejected with HTTP 403 Forbidden by Google servers. Please provide the public YouTube link (https://www.youtube.com/watch?v=... or https://youtu.be/...) instead."
            )

        if is_direct_media_url(url):
            await download_direct_http_stream(video_id, url)
        else:
            try:
                await download_via_ytdl(video_id, url)
            except Exception as ytdl_err:
                if worker_inline_processing.get():
                    raise
                err_str = str(ytdl_err)
                if is_jdownloader_hoster(url) or any(x in err_str.lower() for x in ["piracy", "unsupported", "extractor"]):
                    print(f"[Downloader] yt-dlp unsupported platform ({err_str}), auto-routing to JDownloader 2: {url}")
                    return await download_via_jdownloader(video_id, url, title)

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

        await update_video(video_id, {"status": "FAILED", "error": err_msg})
        await broadcast_progress(
            video_id=video_id,
            title=title,
            source="External URL",
            downloaded_bytes=0,
            total_bytes=0,
            speed_bytes_sec=0,
            status="FAILED", transfer_verified=False,
            error_message=err_msg
        )
        active_downloads.pop(video_id, None)
        if worker_inline_processing.get():
            raise
