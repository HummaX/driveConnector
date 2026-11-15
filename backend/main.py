import os
import re
import shutil
import asyncio
import subprocess
import time
import platform
import mimetypes
import ipaddress
import httpx
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Optional, List, Dict, Any, Union

# Ensure text/vtt MIME type is globally recognized for HTML5 captions & Plyr on all platforms
mimetypes.add_type("text/vtt", ".vtt")
mimetypes.add_type("video/mp4", ".mp4")

from fastapi import (
    FastAPI, HTTPException, Request, Response, BackgroundTasks,
    WebSocket, WebSocketDisconnect, Depends, status, Query
)
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse, Response
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
    create_local_scanned_video,
    update_video,
    delete_video,
    reconcile_stale_jobs
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
from ffmpeg_worker import (
    active_processing,
    transcode_video,
    transcribe_video,
    probe_video,
    extract_embedded_subtitles,
    extract_audio_track,
    resolve_video_file_path
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

def validate_storage_path(target_path: Union[str, Path]) -> Path:
    """
    CYB-06: Strict path traversal guard using os.path.realpath.
    Ensures that resolved path strictly resides within settings.STORAGE_DIR.
    """
    if not target_path:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid empty path specified."
        )
    real_target = os.path.realpath(str(target_path))
    real_storage = os.path.realpath(str(settings.STORAGE_DIR))
    try:
        common = os.path.commonpath([real_target, real_storage])
        if common != real_storage:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied: Path traversal detected outside storage boundary."
            )
    except (ValueError, Exception):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: Path traversal detected outside storage boundary."
        )
    return Path(real_target)

def resolve_storage_path(relative_or_abs_path: Union[str, Path], subfolder: Optional[str] = None) -> Path:
    """
    CYB-06: Resolves and strictly validates that video and metadata file paths
    reside within settings.STORAGE_DIR using os.path.realpath.
    """
    base_dir = Path(settings.STORAGE_DIR)
    if subfolder:
        base_dir = base_dir / subfolder
    
    target = Path(relative_or_abs_path)
    if not target.is_absolute():
        target = base_dir / target
        
    return validate_storage_path(target)

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

def get_flag_emoji(country_code: str) -> str:
    """Converts 2-letter ISO country code into Unicode flag emoji."""
    if not country_code or len(country_code) != 2:
        return "🌐"
    try:
        return "".join(chr(127397 + ord(c.upper())) for c in country_code)
    except Exception:
        return "🌐"

def clean_ip(raw: Optional[str]) -> str:
    """Sanitizes raw IP strings, stripping proxy metadata, ports, and IPv6 brackets."""
    if not raw:
        return ""
    val = raw.strip()
    if "for=" in val.lower():
        m = re.search(r'for=(?:"?\[?)([^;\],\s"]+)', val, re.IGNORECASE)
        if m:
            val = m.group(1).strip()
    if val.startswith("["):
        end = val.find("]")
        if end != -1:
            return val[1:end].strip()
    if val.count(":") == 1:
        val = val.split(":")[0].strip()
    return val.strip("\"' ")

def is_valid_ip(ip: str) -> bool:
    """Checks whether a string is a syntactically valid IPv4 or IPv6 address."""
    try:
        ipaddress.ip_address(clean_ip(ip))
        return True
    except Exception:
        return False

def is_private_ip(ip: str) -> bool:
    """Checks whether an IP address is private, loopback, link-local, or reserved."""
    cleaned = clean_ip(ip)
    try:
        addr = ipaddress.ip_address(cleaned)
        return (
            addr.is_private
            or addr.is_loopback
            or addr.is_link_local
            or addr.is_reserved
            or addr.is_unspecified
        )
    except Exception:
        return True

def get_client_ip(request: Request) -> str:
    """Extracts true client IP from proxy headers or direct client socket."""
    for hdr in ("cf-connecting-ip", "x-forwarded-for", "x-real-ip", "x-client-ip", "forwarded"):
        val = request.headers.get(hdr)
        if val:
            for part in val.split(","):
                ip = clean_ip(part)
                if ip and not is_private_ip(ip):
                    return ip
    if request.client and request.client.host:
        direct = clean_ip(request.client.host)
        if direct and not is_private_ip(direct):
            return direct
    for hdr in ("cf-connecting-ip", "x-forwarded-for", "x-real-ip", "x-client-ip", "forwarded"):
        val = request.headers.get(hdr)
        if val:
            for part in val.split(","):
                ip = clean_ip(part)
                if ip and is_valid_ip(ip):
                    return ip
    if request.client and request.client.host:
        direct = clean_ip(request.client.host)
        if direct and is_valid_ip(direct):
            return direct
    return "127.0.0.1"

class NetworkTelemetryTracker:
    def __init__(self):
        self._geo_cache: Dict[str, Dict[str, Any]] = {}
        self._active_clients: Dict[str, Dict[str, Any]] = {}
        self._lock = asyncio.Lock()
        self.server_node = {
            "name": "OVH-EU-1TB (Roubaix, France)",
            "city": "Roubaix",
            "country": "France",
            "country_code": "FR",
            "flag": "🇫🇷",
            "lat": 50.6927,
            "lng": 3.1746,
            "ip": "51.195.233.247",
            "color": "#38bdf8",
            "size": 1.5
        }

    @staticmethod
    def is_private_ip(ip: str) -> bool:
        return is_private_ip(ip)

    @staticmethod
    def extract_client_ip(request: Request) -> str:
        return get_client_ip(request)

    def update_server_ip(self, request: Optional[Request] = None):
        """Dynamically set server_node['ip'] from request Host header, defaulting to 51.195.233.247."""
        if request:
            try:
                host_hdr = request.headers.get("host", "")
                if host_hdr:
                    host = clean_ip(host_hdr)
                    if not host:
                        host = host_hdr.split(":")[0].strip()
                    if host and host.lower() not in ("localhost", "127.0.0.1", "testserver", "0.0.0.0", "::1"):
                        self.server_node["ip"] = host
                        return
            except Exception:
                pass
        self.server_node["ip"] = "51.195.233.247"

    def _cache_geo(self, ip: str, geo: Dict[str, Any]):
        """Caches GeoIP metadata with FIFO eviction capped at 500 entries."""
        ip = clean_ip(ip)
        if not ip:
            return
        while len(self._geo_cache) >= 500 and ip not in self._geo_cache:
            try:
                oldest_key = next(iter(self._geo_cache))
                del self._geo_cache[oldest_key]
            except (StopIteration, KeyError):
                break
        self._geo_cache[ip] = geo

    async def lookup_geo(self, ip: str) -> Dict[str, Any]:
        ip = clean_ip(ip)
        if not ip or not is_valid_ip(ip):
            ip = "127.0.0.1"

        if ip in self._geo_cache:
            return dict(self._geo_cache[ip])

        if self.is_private_ip(ip):
            geo = {
                "ip": ip,
                "city": "Direct Client",
                "country": "Local Node",
                "country_code": "LOC",
                "flag": "🌐",
                "lat": self.server_node["lat"],
                "lng": self.server_node["lng"]
            }
            self._cache_geo(ip, geo)
            return dict(geo)

        # Provider 1: ip-api.com
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                resp = await client.get(f"http://ip-api.com/json/{ip}?fields=status,country,countryCode,city,lat,lon,query")
                if resp.status_code == 200:
                    data = resp.json()
                    if data.get("status") == "success":
                        cc = data.get("countryCode") or "UN"
                        geo = {
                            "ip": ip,
                            "city": data.get("city") or "Unknown",
                            "country": data.get("country") or "Unknown",
                            "country_code": cc,
                            "flag": get_flag_emoji(cc),
                            "lat": float(data.get("lat", self.server_node["lat"])),
                            "lng": float(data.get("lon", self.server_node["lng"]))
                        }
                        self._cache_geo(ip, geo)
                        return dict(geo)
        except Exception:
            pass

        # Provider 2: ipwho.is fallback
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                resp = await client.get(f"https://ipwho.is/{ip}")
                if resp.status_code == 200:
                    data = resp.json()
                    if data.get("success"):
                        cc = data.get("country_code") or "UN"
                        flag = data.get("flag", {}).get("emoji") if isinstance(data.get("flag"), dict) else None
                        geo = {
                            "ip": ip,
                            "city": data.get("city") or "Unknown",
                            "country": data.get("country") or "Unknown",
                            "country_code": cc,
                            "flag": flag or get_flag_emoji(cc),
                            "lat": float(data.get("latitude", self.server_node["lat"])),
                            "lng": float(data.get("longitude", self.server_node["lng"]))
                        }
                        self._cache_geo(ip, geo)
                        return dict(geo)
        except Exception:
            pass

        geo = {
            "ip": ip,
            "city": "Global Client",
            "country": "Internet Node",
            "country_code": "NET",
            "flag": "🌐",
            "lat": 48.8566,
            "lng": 2.3522
        }
        self._cache_geo(ip, geo)
        return dict(geo)

    async def register_hit(self, ip: str, path: str = "/", client_override: Optional[Dict[str, Any]] = None):
        ip = clean_ip(ip)
        if not ip or not is_valid_ip(ip):
            ip = "127.0.0.1"
        geo = await self.lookup_geo(ip)
        if client_override:
            if client_override.get("country"):
                geo["country"] = client_override["country"]
            if client_override.get("country_code"):
                geo["country_code"] = str(client_override["country_code"]).upper()
                geo["flag"] = get_flag_emoji(geo["country_code"])
            if client_override.get("city"):
                geo["city"] = client_override["city"]
            if client_override.get("lat") and client_override.get("lng"):
                try:
                    geo["lat"] = float(client_override["lat"])
                    geo["lng"] = float(client_override["lng"])
                except (ValueError, TypeError):
                    pass
            self._cache_geo(ip, geo)

        now = time.time()
        key = ip
        async with self._lock:
            # Prune sessions older than 300 seconds
            self._active_clients = {
                k: v for k, v in self._active_clients.items()
                if now - v.get("last_seen", 0) < 300
            }

            if key not in self._active_clients:
                self._active_clients[key] = {
                    "ip": ip,
                    "city": geo["city"],
                    "country": geo["country"],
                    "country_code": geo["country_code"],
                    "flag": geo["flag"],
                    "lat": geo["lat"],
                    "lng": geo["lng"],
                    "hits": 1,
                    "first_seen": now,
                    "last_seen": now,
                    "path": path
                }
            else:
                self._active_clients[key]["hits"] += 1
                self._active_clients[key]["last_seen"] = now
                self._active_clients[key]["path"] = path
                self._active_clients[key]["city"] = geo["city"]
                self._active_clients[key]["country"] = geo["country"]
                self._active_clients[key]["country_code"] = geo["country_code"]
                self._active_clients[key]["flag"] = geo["flag"]
                self._active_clients[key]["lat"] = geo["lat"]
                self._active_clients[key]["lng"] = geo["lng"]

        # Persist visitor telemetry to MongoDB if available
        try:
            db = get_db()
            await db.network_telemetry.update_one(
                {"ip": key},
                {
                    "$set": {
                        "city": geo["city"],
                        "country": geo["country"],
                        "country_code": geo["country_code"],
                        "flag": geo["flag"],
                        "lat": geo["lat"],
                        "lng": geo["lng"],
                        "last_seen": now,
                        "path": path
                    },
                    "$inc": {"hits": 1},
                    "$setOnInsert": {"first_seen": now}
                },
                upsert=True
            )
        except Exception:
            pass

    async def get_telemetry(self, current_ip: Optional[str] = None, request: Optional[Request] = None) -> Dict[str, Any]:
        if request:
            self.update_server_ip(request)
        now = time.time()

        # Query recent distinct visitor nodes from MongoDB if available
        db_clients: Dict[str, Dict[str, Any]] = {}
        try:
            db = get_db()
            cursor = db.network_telemetry.find().sort("last_seen", -1).limit(50)
            async for doc in cursor:
                doc_ip = doc.get("ip")
                if doc_ip:
                    db_clients[doc_ip] = {
                        "ip": doc_ip,
                        "city": doc.get("city", "Visitor"),
                        "country": doc.get("country", "Global"),
                        "country_code": doc.get("country_code", "UN"),
                        "flag": doc.get("flag", "🌐"),
                        "lat": doc.get("lat", self.server_node["lat"]),
                        "lng": doc.get("lng", self.server_node["lng"]),
                        "hits": doc.get("hits", 1),
                        "last_seen": doc.get("last_seen", now),
                        "path": doc.get("path", "/")
                    }
        except Exception:
            pass

        async with self._lock:
            self._active_clients = {
                k: v for k, v in self._active_clients.items()
                if now - v.get("last_seen", 0) < 300
            }
            active_list = list(self._active_clients.values())
            # Merge: active sessions take precedence over older DB records
            merged = {**db_clients, **self._active_clients}
            clients_list = list(merged.values())

        current_geo = None
        if current_ip:
            if current_ip in merged:
                current_geo = merged[current_ip]
            else:
                current_geo = await self.lookup_geo(current_ip)

        countries_map: Dict[str, Dict[str, Any]] = {}
        for c in clients_list:
            code = c.get("country_code", "UN")
            if code not in countries_map:
                countries_map[code] = {
                    "code": code,
                    "name": c.get("country", "Unknown"),
                    "flag": c.get("flag", "🌐"),
                    "count": 0
                }
            countries_map[code]["count"] += 1

        client_nodes = []
        for c in clients_list:
            masked_ip = ".".join(c["ip"].split(".")[:3]) + ".xxx" if "." in c["ip"] else c["ip"]
            is_active = (now - c.get("last_seen", 0)) < 300
            client_nodes.append({
                "lat": c["lat"],
                "lng": c["lng"],
                "name": f"{c['city']}, {c['country']} ({masked_ip})",
                "city": c["city"],
                "country": c["country"],
                "country_code": c["country_code"],
                "flag": c["flag"],
                "ip": masked_ip,
                "color": "#34d399" if is_active else "#94a3b8",
                "active": is_active,
                "hits": c.get("hits", 1)
            })

        return {
            "server_node": self.server_node,
            "current_client": current_geo,
            "active_connections": max(1, len(active_list)),
            "unique_countries_count": max(1, len(countries_map)),
            "countries": list(countries_map.values()),
            "client_nodes": client_nodes
        }

network_tracker = NetworkTelemetryTracker()

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Initialize MongoDB, ensure directories exist, seed admin user, prime network counters
    await init_db()
    await init_admin_user()
    await reconcile_stale_jobs()
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

@app.middleware("http")
async def track_network_traffic(request: Request, call_next):
    path = request.url.path
    if request.method != "OPTIONS":
        # Skip static assets and metrics routes to reduce telemetry overhead
        skip_prefixes = (
            "/static", "/css", "/js", "/favicon", "/metadata",
            "/metrics", "/api/system/metrics", "/api/network"
        )
        skip_extensions = (
            ".css", ".js", ".png", ".jpg", ".jpeg", ".ico",
            ".svg", ".vtt", ".map", ".woff", ".woff2", ".webmanifest"
        )
        if not (path.startswith(skip_prefixes) or any(path.endswith(ext) for ext in skip_extensions)):
            # Cap _geo_cache at 500 entries
            while len(network_tracker._geo_cache) > 500:
                try:
                    oldest_key = next(iter(network_tracker._geo_cache))
                    del network_tracker._geo_cache[oldest_key]
                except (StopIteration, KeyError):
                    break

            network_tracker.update_server_ip(request)
            ip = get_client_ip(request)
            client_override = None
            c_country = request.headers.get("x-client-country")
            c_city = request.headers.get("x-client-city")
            c_lat = request.headers.get("x-client-lat")
            c_lng = request.headers.get("x-client-lng")
            if c_country and c_lat and c_lng:
                try:
                    client_override = {
                        "country": c_country,
                        "city": c_city or "Visitor",
                        "country_code": request.headers.get("x-client-country-code") or "UN",
                        "lat": float(c_lat),
                        "lng": float(c_lng)
                    }
                except Exception:
                    pass
            try:
                asyncio.create_task(network_tracker.register_hit(ip, path, client_override))
            except Exception:
                pass
    return await call_next(request)

# WebVTT scrubber cue fallback route (eliminates 404 console errors while sprites generate)
@app.get("/metadata/{video_id}/thumbnails.vtt")
async def get_video_thumbnails_vtt(video_id: str):
    """
    Serves WebVTT thumbnail cues for scrub bars.
    Returns HTTP 200 with valid empty WebVTT if sprites have not finished generating,
    eliminating 404 console errors in HTML5 / Video.js / Plyr players.
    """
    valid_id = validate_video_id(video_id)
    vtt_path = settings.get_video_metadata_dir(valid_id) / "thumbnails.vtt"
    if vtt_path.exists() and vtt_path.stat().st_size > 10:
        return FileResponse(vtt_path, media_type="text/vtt")
    return Response(
        content="WEBVTT\n\n",
        media_type="text/vtt",
        headers={"Cache-Control": "no-cache"}
    )

# Mount static asset directory
app.mount("/metadata", StaticFiles(directory=str(settings.metadata_dir)), name="metadata")

# Mount built-in single-page Web UI
static_ui_dir = Path(__file__).parent / "static"
if static_ui_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_ui_dir)), name="static")

# Mount frontend assets
frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
frontend_css_dir = frontend_dir / "css"
frontend_js_dir = frontend_dir / "js"
try:
    frontend_css_dir.mkdir(parents=True, exist_ok=True)
    frontend_js_dir.mkdir(parents=True, exist_ok=True)
except OSError:
    pass

app.mount("/css", StaticFiles(directory=str(frontend_css_dir)), name="css")
app.mount("/js", StaticFiles(directory=str(frontend_js_dir)), name="js")

@app.get("/login", include_in_schema=False)
@app.get("/login.html", include_in_schema=False)
async def serve_login():
    login_file = frontend_dir / "login.html"
    if login_file.exists():
        return FileResponse(str(login_file))
    return Response(status_code=404)

@app.get("/", include_in_schema=False)
async def serve_root():
    frontend_index = frontend_dir / "index.html"
    if frontend_index.exists():
        return FileResponse(str(frontend_index))
    dist_index = frontend_dir / "dist" / "index.html"
    if dist_index.exists():
        return FileResponse(str(dist_index))
    index_file = static_ui_dir / "index.html"
    if index_file.exists():
        return FileResponse(str(index_file))
    return {"status": "ok", "message": "DriveConnector API running"}

@app.get("/favicon.ico", include_in_schema=False)
async def serve_favicon():
    favicon_file = static_ui_dir / "favicon.ico"
    if favicon_file.exists():
        return FileResponse(str(favicon_file), media_type="image/x-icon")
    return Response(status_code=404)

# ----------------- Real-Time Global Network & GeoIP Telemetry -----------------
class ClientGeoRegistration(BaseModel):
    ip: Optional[str] = None
    city: Optional[str] = None
    country: Optional[str] = None
    country_code: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None

@app.get("/api/network/geo")
async def get_network_geo(request: Request, current_user: Dict[str, Any] = Depends(get_current_user)):
    """Returns real-time geolocation of server node, connected client nodes, and active countries."""
    network_tracker.update_server_ip(request)
    ip = get_client_ip(request)
    return await network_tracker.get_telemetry(ip, request=request)

@app.post("/api/network/register-client")
async def register_client_geo(
    payload: ClientGeoRegistration,
    request: Request,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    """Allows client browser to register its real external GeoIP (useful when behind Docker bridge NAT)."""
    network_tracker.update_server_ip(request)
    ip = clean_ip(payload.ip) if (payload.ip and is_valid_ip(payload.ip)) else get_client_ip(request)
    override = payload.model_dump()
    override["ip"] = ip
    await network_tracker.register_hit(ip, request.url.path, override)
    return {"status": "registered", "geo": await network_tracker.lookup_geo(ip)}

# ----------------- Authentication Endpoints & Rate Limiting -----------------
# In-memory sliding-window rate limiting for login endpoints (CYB-07)
# Enforces maximum 10 failed login attempts per client IP per 5 minutes
LOGIN_FAILED_ATTEMPTS: Dict[str, List[float]] = {}
LOGIN_MAX_FAILED_ATTEMPTS: int = 10
LOGIN_RATE_LIMIT_WINDOW_SECONDS: int = 300  # 5 minutes
_login_rate_limit_lock = asyncio.Lock()

async def check_login_rate_limit(client_ip: str):
    """Enforces sliding-window rate limit: raises 429 if failed attempts >= 10 in 5m."""
    now = time.time()
    async with _login_rate_limit_lock:
        timestamps = LOGIN_FAILED_ATTEMPTS.get(client_ip, [])
        valid_timestamps = [t for t in timestamps if now - t < LOGIN_RATE_LIMIT_WINDOW_SECONDS]
        LOGIN_FAILED_ATTEMPTS[client_ip] = valid_timestamps
        if len(valid_timestamps) >= LOGIN_MAX_FAILED_ATTEMPTS:
            earliest = valid_timestamps[0]
            retry_after = max(1, int(LOGIN_RATE_LIMIT_WINDOW_SECONDS - (now - earliest)))
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Too many failed login attempts. Account temporarily locked for {retry_after} seconds.",
                headers={"Retry-After": str(retry_after)}
            )

async def record_login_failure(client_ip: str):
    """Records a failed login attempt for sliding-window calculation."""
    now = time.time()
    async with _login_rate_limit_lock:
        timestamps = LOGIN_FAILED_ATTEMPTS.setdefault(client_ip, [])
        timestamps.append(now)
        LOGIN_FAILED_ATTEMPTS[client_ip] = [t for t in timestamps if now - t < LOGIN_RATE_LIMIT_WINDOW_SECONDS]

async def record_login_success(client_ip: str):
    """Clears failed login attempts for client IP upon successful login."""
    async with _login_rate_limit_lock:
        LOGIN_FAILED_ATTEMPTS.pop(client_ip, None)

@app.post("/api/auth/login")
@app.post("/api/login")
async def login(credentials: UserLogin, request: Request):
    """Authenticates credentials and returns a signed JWT access token with brute-force rate limiting."""
    client_ip = get_client_ip(request)
    await check_login_rate_limit(client_ip)

    try:
        user = await get_user_by_username(credentials.username.strip())
    except Exception:
        user = None

    if not user or not verify_password(credentials.password, user["password_hash"]):
        await record_login_failure(client_ip)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password"
        )
    
    await record_login_success(client_ip)
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
    url: Optional[str] = None
    urls: Optional[List[str]] = None
    title: Optional[str] = None
    engine: Optional[str] = "auto"

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

class TranscodeRequest(BaseModel):
    quality: str = "720p"
    replace_original: Optional[bool] = False

class VideoClipRequest(BaseModel):
    start_sec: float
    end_sec: float

class SetPosterRequest(BaseModel):
    timestamp: float

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
    for v_id, pstate in active_processing.items():
        try:
            await websocket.send_json(pstate)
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

@app.get("/api/videos/playlist.m3u")
async def get_videos_playlist_m3u(
    request: Request,
    current_user: Dict[str, Any] = Depends(get_current_user_flexible)
):
    """
    Scans LOCAL_READY videos in catalog and returns standard #EXTM3U playlist
    with authenticated stream URLs (/api/stream/{id}?token=...) for VLC/Infuse/Apple TV.
    """
    username = current_user.get("username", settings.ADMIN_USERNAME)
    stream_token = create_access_token(data={"sub": username})

    try:
        videos = await list_videos(status="LOCAL_READY")
    except Exception as e:
        print(f"[Playlist] Notice: Could not query database: {e}")
        videos = []

    proto = request.headers.get("x-forwarded-proto") or request.url.scheme or "http"
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    base_url = f"{proto}://{host}".rstrip("/")

    lines = ["#EXTM3U"]
    for v in videos:
        vid = v.get("video_id")
        if not vid:
            continue
        title = v.get("title") or v.get("filename") or vid
        dur_val = v.get("duration_seconds")
        duration = int(float(dur_val)) if dur_val is not None else -1
        stream_url = f"{base_url}/api/stream/{vid}?token={stream_token}"
        lines.append(f"#EXTINF:{duration},{title}")
        lines.append(stream_url)

    content = "\n".join(lines) + "\n"
    return Response(
        content=content,
        media_type="application/x-mpegurl",
        headers={"Content-Disposition": 'inline; filename="playlist.m3u"'}
    )

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
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
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
    """Downloads external URL link(s) with SSRF protection and multi-URL queueing (Requires Authentication)."""
    raw_urls: List[str] = []
    if payload.urls:
        for u in payload.urls:
            u_clean = u.strip()
            if u_clean and u_clean not in raw_urls:
                raw_urls.append(u_clean)
    if payload.url:
        for line in payload.url.replace(",", "\n").splitlines():
            line_str = line.strip()
            if line_str and line_str not in raw_urls:
                raw_urls.append(line_str)

    if not raw_urls:
        raise HTTPException(status_code=400, detail="No valid URL provided. Enter one or more video URLs.")

    queued_videos = []
    errors = []
    req_engine = (payload.engine or "auto").lower().strip()

    for idx, clean_url in enumerate(raw_urls):
        try:
            if ("googlevideo.com" in clean_url and "videoplayback" in clean_url) or ("&sig=" in clean_url and "itag=" in clean_url and "googlevideo" in clean_url):
                raise ValueError("Direct Google Video CDN stream chunks (googlevideo.com/videoplayback) are IP-bound to personal browsers. Please provide the public YouTube link instead.")

            # Assign custom title only if a single URL was submitted
            item_title = payload.title if len(raw_urls) == 1 else None
            video = await create_url_video(url=clean_url, title=item_title)
            video_id = video["video_id"]
            background_tasks.add_task(download_external_url, video_id, clean_url, req_engine)
            queued_videos.append(video)
        except Exception as e:
            if len(raw_urls) == 1:
                # Single URL request: surface immediate 400 with specific error
                raise HTTPException(status_code=400, detail=str(e))
            errors.append({"url": clean_url, "error": str(e)})

    if not queued_videos and errors:
        raise HTTPException(status_code=400, detail=f"Failed to queue downloads: {errors[0]['error']}")

    return {
        "message": f"Queued {len(queued_videos)} download(s)",
        "count": len(queued_videos),
        "queued": queued_videos,
        "errors": errors,
        "video": queued_videos[0] if queued_videos else None
    }

@app.post("/api/videos/scan-local")
async def scan_local_storage(
    background_tasks: BackgroundTasks,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Scans /mnt/storage/videos for local media files (e.g. downloaded by JDownloader or scp).
    Automatically registers any uncataloged videos and triggers background processing.
    """
    scanned_extensions = {".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v", ".ts"}
    discovered = []

    existing_videos = await list_videos()
    known_paths = set()
    for v in existing_videos:
        lp = v.get("local_path")
        if lp:
            known_paths.add(str(Path(lp).resolve()))
        vid = v.get("video_id")
        if vid:
            for ext in scanned_extensions:
                known_paths.add(str((settings.videos_dir / f"{vid}{ext}").resolve()))

    for file_path in settings.videos_dir.iterdir():
        if not file_path.is_file():
            continue
        if file_path.name.endswith(".part") or file_path.name.endswith(".tmp") or file_path.name.endswith(".orig"):
            continue
        if any(f"_{q}.mp4" in file_path.name for q in ["720p", "480p", "360p"]):
            continue
        if file_path.suffix.lower() not in scanned_extensions:
            continue
        if str(file_path.resolve()) in known_paths:
            continue

        video_doc = await create_local_scanned_video(file_path)
        video_id = video_doc["video_id"]
        discovered.append(video_doc)

        from ffmpeg_worker import process_video_background
        background_tasks.add_task(process_video_background, video_id)

    return {
        "status": "success",
        "found_count": len(discovered),
        "discovered": discovered,
        "message": f"Storage scan complete: {len(discovered)} new video(s) cataloged."
    }

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

    local_p = video.get("local_path")
    if local_p and Path(local_p).exists():
        try:
            safe_local = validate_storage_path(Path(local_p))
            os.remove(safe_local)
        except (OSError, HTTPException):
            pass

    for match in settings.videos_dir.glob(f"{valid_id}.*"):
        try:
            safe_match = validate_storage_path(match)
            os.remove(safe_match)
        except (OSError, HTTPException):
            pass

    meta_dir = settings.metadata_dir / valid_id
    if meta_dir.exists():
        try:
            safe_meta = validate_storage_path(meta_dir)
            shutil.rmtree(safe_meta)
        except (OSError, HTTPException):
            pass

    # Clean up multi-resolution renditions if present
    for q in ["720p", "480p", "360p"]:
        r_file = settings.videos_dir / f"{valid_id}_{q}.mp4"
        if r_file.exists():
            try:
                safe_r = validate_storage_path(r_file)
                os.remove(safe_r)
            except (OSError, HTTPException):
                pass

    await delete_video(valid_id)
    return {"status": "deleted", "video_id": valid_id}

# ----------------- Transcoding & Transcription Operations (Auth Guarded) -----------------
@app.post("/api/videos/{video_id}/transcode")
async def trigger_video_transcode(
    video_id: str,
    payload: TranscodeRequest,
    background_tasks: BackgroundTasks,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    """Triggers background downscaling/transcoding to 720p, 480p, or 360p (Requires Auth)."""
    valid_id = validate_video_id(video_id)
    video = await get_video(valid_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    if video.get("status") != "LOCAL_READY":
        raise HTTPException(status_code=400, detail="Video must be stored locally before transcoding.")

    quality = payload.quality.lower().strip()
    if quality not in ["720p", "480p", "360p"]:
        raise HTTPException(status_code=400, detail=f"Unsupported quality '{quality}'. Allowed: 720p, 480p, 360p.")

    if valid_id in active_processing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Video is currently being processed ({active_processing[valid_id].get('stage_name', 'in progress')})."
        )

    background_tasks.add_task(transcode_video, valid_id, quality, payload.replace_original or False)
    return {
        "status": "queued",
        "video_id": valid_id,
        "quality": quality,
        "replace_original": payload.replace_original or False,
        "message": f"Transcoding to {quality} started in background"
    }

@app.post("/api/videos/{video_id}/transcribe")
async def trigger_video_transcription(
    video_id: str,
    background_tasks: BackgroundTasks,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    """Triggers local AI subtitle transcription using faster-whisper (Requires Auth)."""
    valid_id = validate_video_id(video_id)
    video = await get_video(valid_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    if video.get("status") != "LOCAL_READY":
        raise HTTPException(status_code=400, detail="Video must be stored locally before transcribing.")

    if valid_id in active_processing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Video is currently being processed ({active_processing[valid_id].get('stage_name', 'in progress')})."
        )

    background_tasks.add_task(transcribe_video, valid_id)
    return {
        "status": "queued",
        "video_id": valid_id,
        "message": "AI Subtitle transcription initiated in background"
    }

@app.post("/api/videos/{video_id}/reset-status")
async def reset_video_status(
    video_id: str,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    """Manually resets a video's status to LOCAL_READY if stuck in PROCESSING (Requires Auth)."""
    valid_id = validate_video_id(video_id)
    video = await get_video(valid_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    active_processing.pop(valid_id, None)
    active_downloads.pop(valid_id, None)

    updated = await update_video(valid_id, {
        "status": "LOCAL_READY",
        "processing_info": None
    })
    await manager.broadcast({
        "event": "PROCESSING_COMPLETE",
        "video_id": valid_id,
        "status": "LOCAL_READY",
        "metadata": updated
    })
    return {"status": "success", "message": "Video status reset to LOCAL_READY", "video": updated}

@app.post("/api/videos/{video_id}/probe-tracks")
async def probe_and_extract_tracks(
    video_id: str,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Probes audio and subtitle tracks for a video, extracts embedded text subtitles
    into WebVTT format, updates the database, and returns the track metadata.
    """
    valid_id = validate_video_id(video_id)
    video = await get_video(valid_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    video_path = resolve_video_file_path(video)
    if not video_path or not video_path.exists():
        raise HTTPException(status_code=400, detail="Video file not available locally on server disk")

    video_path = validate_storage_path(video_path)
    meta_dir = validate_storage_path(settings.get_video_metadata_dir(valid_id))

    info = await probe_video(video_path)
    audio_tracks = info.get("audio_tracks", [])
    raw_subs = info.get("subtitle_tracks", [])
    chapters = info.get("chapters", [])

    extracted_subs = await extract_embedded_subtitles(valid_id, video_path, meta_dir, raw_subs)

    update_payload = {
        "audio_tracks": audio_tracks,
        "subtitle_tracks": extracted_subs,
        "chapters": chapters
    }
    if not video.get("subtitles_url"):
        default_sub = next((s["url"] for s in extracted_subs if s.get("url") and s.get("language") in ("eng", "en")), None)
        if not default_sub:
            default_sub = next((s["url"] for s in extracted_subs if s.get("url")), None)
        if default_sub:
            update_payload["subtitles_url"] = default_sub

    updated = await update_video(valid_id, update_payload)
    await manager.broadcast({
        "event": "TRACKS_UPDATED",
        "video_id": valid_id,
        "audio_tracks": audio_tracks,
        "subtitle_tracks": extracted_subs,
        "metadata": updated
    })
    return {
        "status": "success",
        "audio_tracks": audio_tracks,
        "subtitle_tracks": extracted_subs,
        "chapters": chapters,
        "video": updated
    }

@app.post("/api/videos/{video_id}/clip")
async def clip_video_endpoint(
    video_id: str,
    payload: VideoClipRequest,
    current_user: Dict[str, Any] = Depends(get_current_user_flexible)
):
    """
    Accepts JSON start_sec and end_sec, validates input, runs:
    ffmpeg -y -ss {start_sec} -to {end_sec} -i {local_path} -c copy -movflags +faststart {output_clip}
    in asyncio.to_thread, and returns FileResponse for instant lossless download.
    """
    valid_id = validate_video_id(video_id)
    if payload.start_sec < 0:
        raise HTTPException(status_code=400, detail="start_sec must be non-negative")
    if payload.end_sec <= payload.start_sec:
        raise HTTPException(status_code=400, detail="end_sec must be greater than start_sec")

    video = await get_video(valid_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    local_path = resolve_video_file_path(video)
    if not local_path or not local_path.exists():
        raise HTTPException(status_code=400, detail="Video file not available locally on server disk")
    local_path = validate_storage_path(local_path)

    meta_dir = validate_storage_path(settings.get_video_metadata_dir(valid_id))
    output_clip = meta_dir / f"clip_{int(payload.start_sec)}_{int(payload.end_sec)}.mp4"

    def run_ffmpeg_clip():
        cmd = [
            "ffmpeg", "-y",
            "-ss", str(payload.start_sec),
            "-to", str(payload.end_sec),
            "-i", str(local_path),
            "-c", "copy",
            "-movflags", "+faststart",
            str(output_clip)
        ]
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if proc.returncode != 0:
            err = proc.stderr.decode("utf-8", errors="ignore")
            raise RuntimeError(f"FFmpeg clipping failed: {err}")

    try:
        await asyncio.to_thread(run_ffmpeg_clip)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    if not output_clip.exists():
        raise HTTPException(status_code=500, detail="Failed to produce clip file")

    base_name = Path(video.get("filename") or video.get("title") or valid_id).stem
    download_filename = f"{base_name}_clip_{int(payload.start_sec)}_{int(payload.end_sec)}.mp4"
    return FileResponse(
        path=str(output_clip),
        media_type="video/mp4",
        filename=download_filename
    )

@app.post("/api/videos/{video_id}/set-poster")
async def set_video_poster_endpoint(
    video_id: str,
    payload: SetPosterRequest,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Accepts JSON timestamp (seconds), runs:
    ffmpeg -y -ss {timestamp} -i {local_path} -frames:v 1 -q:v 2 {poster_path}
    and updates video document in MongoDB with custom_poster: True.
    """
    valid_id = validate_video_id(video_id)
    if payload.timestamp < 0:
        raise HTTPException(status_code=400, detail="timestamp must be non-negative")

    video = await get_video(valid_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    local_path = resolve_video_file_path(video)
    if not local_path or not local_path.exists():
        raise HTTPException(status_code=400, detail="Video file not available locally on server disk")
    local_path = validate_storage_path(local_path)

    meta_dir = validate_storage_path(settings.get_video_metadata_dir(valid_id))
    poster_path = meta_dir / "poster.jpg"

    def run_ffmpeg_poster():
        cmd = [
            "ffmpeg", "-y",
            "-ss", str(payload.timestamp),
            "-i", str(local_path),
            "-frames:v", "1",
            "-q:v", "2",
            str(poster_path)
        ]
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if proc.returncode != 0:
            err = proc.stderr.decode("utf-8", errors="ignore")
            raise RuntimeError(f"FFmpeg poster extraction failed: {err}")

    try:
        await asyncio.to_thread(run_ffmpeg_poster)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    poster_url = f"/metadata/{valid_id}/poster.jpg"
    update_data = {
        "custom_poster": True,
        "has_poster": True,
        "poster_url": poster_url
    }
    updated = await update_video(valid_id, update_data)
    await manager.broadcast({
        "event": "POSTER_UPDATED",
        "video_id": valid_id,
        "custom_poster": True,
        "poster_url": poster_url,
        "metadata": updated
    })

    return {
        "status": "success",
        "video_id": valid_id,
        "custom_poster": True,
        "poster_url": poster_url
    }

@app.post("/api/videos/{video_id}/evict-local")
async def evict_local_video(
    video_id: str,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Deletes /mnt/storage/videos/{video_id}.*, resets Google Drive videos to status: "REMOTE_ONLY"
    in MongoDB, and leaves metadata intact.
    """
    valid_id = validate_video_id(video_id)
    video = await get_video(valid_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    deleted_files = []
    videos_dir = settings.videos_dir

    # 1. Delete /mnt/storage/videos/{video_id}.*
    for f in videos_dir.glob(f"{valid_id}.*"):
        try:
            if f.is_file():
                f.unlink(missing_ok=True)
                deleted_files.append(f.name)
        except Exception as e:
            print(f"[Evict] Error deleting {f}: {e}")

    # Also delete if local_path points to a specific file inside videos_dir
    local_p = video.get("local_path")
    if local_p:
        try:
            p = Path(local_p)
            if p.exists() and p.is_file() and str(videos_dir) in str(p.resolve()):
                p.unlink(missing_ok=True)
                if p.name not in deleted_files:
                    deleted_files.append(p.name)
        except Exception:
            pass

    # 2. Reset Google Drive videos to status: "REMOTE_ONLY" in MongoDB, clear local_path, preserve metadata
    is_drive_video = bool(video.get("drive_file_id"))
    update_data: Dict[str, Any] = {
        "local_path": None
    }
    if is_drive_video:
        update_data["status"] = "REMOTE_ONLY"

    active_processing.pop(valid_id, None)
    active_downloads.pop(valid_id, None)

    updated = await update_video(valid_id, update_data)
    await manager.broadcast({
        "event": "VIDEO_EVICTED",
        "video_id": valid_id,
        "status": update_data.get("status", video.get("status")),
        "metadata": updated
    })

    return {
        "status": "success",
        "video_id": valid_id,
        "is_drive_video": is_drive_video,
        "new_status": update_data.get("status", video.get("status")),
        "deleted_files": deleted_files,
        "message": f"Evicted local video files for {valid_id}."
    }

STREAM_BURST_CHUNK_SIZE_BYTES: int = 16 * 1024 * 1024  # 16MB burst chunk for responsive HTTP 206 progressive start & open-ended Range: bytes=start- requests

@app.get("/api/videos/{video_id}/audio/{track_index}")
@app.head("/api/videos/{video_id}/audio/{track_index}")
async def stream_audio_track(
    video_id: str,
    track_index: int,
    request: Request,
    current_user: Dict[str, Any] = Depends(get_current_user_flexible)
):
    """
    RFC 7233 Range Streaming for a specific audio track extracted to AAC format.
    Allows browsers to switch and play alternate audio tracks (e.g. Hindi, English, Spanish).
    """
    valid_id = validate_video_id(video_id)
    video = await get_video(valid_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found in catalog")
    if video.get("status") == "REMOTE_ONLY":
        raise HTTPException(status_code=409, detail="Video is stored in cloud. Download locally to stream alternate audio tracks.")

    if track_index < 0:
        raise HTTPException(status_code=400, detail="Invalid audio track index")

    audio_path = await extract_audio_track(valid_id, track_index)
    if not audio_path or not audio_path.exists():
        raise HTTPException(status_code=404, detail=f"Audio track {track_index} not found or extraction failed")
    audio_path = validate_storage_path(audio_path)

    file_size = audio_path.stat().st_size
    range_header = request.headers.get("range")
    content_type = "audio/mp4"

    if not range_header:
        headers = {
            "Content-Length": str(file_size),
            "Content-Type": content_type,
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=86400",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, *",
        }
        if request.method == "HEAD":
            return Response(content=b"", status_code=200, headers=headers)
        def full_audio_iterator():
            with open(audio_path, "rb") as f:
                while chunk := f.read(STREAM_BURST_CHUNK_SIZE_BYTES):
                    yield chunk
        return StreamingResponse(full_audio_iterator(), headers=headers)

    range_match = re.match(r"bytes=(\d*)-(\d*)", range_header.strip())
    if not range_match:
        raise HTTPException(status_code=416, detail="Invalid Range Header format")

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

    # Responsive 16MB HTTP 206 Partial Content byte-range burst cap
    max_chunk = STREAM_BURST_CHUNK_SIZE_BYTES
    if (end - start + 1) > max_chunk:
        end = start + max_chunk - 1

    content_length = end - start + 1
    def audio_range_stream():
        with open(audio_path, "rb") as f:
            f.seek(start)
            remaining = content_length
            while remaining > 0:
                chunk_size = min(remaining, settings.STREAM_CHUNK_SIZE_BYTES)
                data = f.read(chunk_size)
                if not data:
                    break
                remaining -= len(data)
                yield data

    headers = {
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(content_length),
        "Content-Type": content_type,
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, *",
    }
    if request.method == "HEAD":
        return Response(content=b"", status_code=206, headers=headers)
    return StreamingResponse(audio_range_stream(), status_code=206, headers=headers)

# ----------------- RFC 7233 Range Streaming (Cryptographically Auth Guarded) -----------------
ALLOWED_STREAM_QUALITIES = {"720p", "480p", "360p", "1080p", "original", "source"}

@app.get("/api/stream/{video_id}")
@app.head("/api/stream/{video_id}")
async def stream_video(
    video_id: str,
    request: Request,
    quality: Optional[str] = Query(None),
    current_user: Dict[str, Any] = Depends(get_current_user_flexible)
):
    """
    Authenticated HTTP Range Request Streaming Engine.
    Accepts Authorization Header, ?token= parameter, or cookie.
    Accepts ?quality=720p, ?quality=480p, ?quality=360p for adaptive downscaled playback.
    Unauthorized users cannot stream video content.
    """
    valid_id = validate_video_id(video_id)
    video = await get_video(valid_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found in catalog")

    video_path = resolve_video_file_path(video)
    if not video_path or not video_path.exists():
        video_path = settings.videos_dir / f"{valid_id}.mp4"

    # Multi-resolution quality selection with strict whitelist validation
    if quality:
        clean_q = quality.lower().strip()
        if clean_q not in ALLOWED_STREAM_QUALITIES:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unsupported quality '{quality}'")

        if clean_q not in ["original", "1080p", "source"]:
            custom_path = video.get("renditions", {}).get(clean_q, {}).get("path")
            rendition_file = settings.videos_dir / f"{valid_id}_{clean_q}.mp4"
            if custom_path and Path(custom_path).exists():
                video_path = Path(custom_path)
            elif rendition_file.exists():
                video_path = rendition_file

    video_path = validate_storage_path(video_path)

    if not video_path.exists() or video.get("status") == "REMOTE_ONLY":
        raise HTTPException(
            status_code=409,
            detail={"error": "VIDEO_REMOTE_ONLY", "message": "Video is stored on cloud. Click to fetch locally."}
        )

    file_size = video_path.stat().st_size
    range_header = request.headers.get("range")

    suffix = video_path.suffix.lower()
    content_type_map = {
        ".mp4": "video/mp4",
        ".mkv": "video/x-matroska",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
        ".avi": "video/x-msvideo",
        ".m4v": "video/x-m4v",
        ".ts": "video/mp2t",
        ".flv": "video/x-flv",
    }
    content_type = content_type_map.get(suffix, "video/mp4")

    if not range_header:
        headers = {
            "Content-Type": content_type,
            "Content-Length": str(file_size),
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=86400",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, *",
        }
        if request.method == "HEAD":
            return Response(content=b"", status_code=200, headers=headers)

        def file_iterator():
            with open(video_path, "rb") as f:
                while chunk := f.read(STREAM_BURST_CHUNK_SIZE_BYTES):
                    yield chunk

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

    max_chunk = STREAM_BURST_CHUNK_SIZE_BYTES
    if (end - start + 1) > max_chunk:
        end = start + max_chunk - 1

    content_length = end - start + 1

    headers = {
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(content_length),
        "Content-Type": content_type,
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, *",
    }
    if request.method == "HEAD":
        return Response(content=b"", status_code=206, headers=headers)

    def range_stream():
        with open(video_path, "rb") as f:
            f.seek(start)
            remaining = content_length
            while remaining > 0:
                chunk_size = min(remaining, settings.STREAM_CHUNK_SIZE_BYTES)
                data = f.read(chunk_size)
                if not data:
                    break
                remaining -= len(data)
                yield data

    return StreamingResponse(
        range_stream(),
        status_code=206,
        headers=headers
    )

# ----------------- Hardware & Process Telemetry (Auth Guarded) -----------------
@app.get("/api/system/metrics")
async def get_system_metrics(
    request: Request,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
    """Comprehensive Hardware & Operational Metrics (Requires Authentication)."""
    update_network_rates()
    client_ip = network_tracker.extract_client_ip(request)
    geo_telemetry = await network_tracker.get_telemetry(client_ip)

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

    # RAM metrics (32GB system profile: 10% host reserve, 90% cloud pipeline)
    ram_total_gb = settings.total_ram_gb
    ram_used_gb = 2.0
    ram_free_gb = round(max(0.0, ram_total_gb - ram_used_gb), 2)
    ram_percent = round((ram_used_gb / ram_total_gb) * 100, 1) if ram_total_gb > 0 else 6.2
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
    in_queue = len([
        t for t in active_downloads.values() 
        if t.get("status") in ("DOWNLOADING", "QUEUED") and float(t.get("percentage", 0)) < 100
    ])

    # Active download speed sum (only active in-progress downloads)
    live_dl_speed = sum(
        t.get("speed_mbs", 0.0) 
        for t in active_downloads.values() 
        if t.get("status") == "DOWNLOADING" and float(t.get("percentage", 0)) < 100
    )

    uptime_sec = int(time.time() - SERVER_START_TIME)

    return {
        "cpu": {
            "percent": cpu_percent,
            "cores": cpu_cores,
            "worker_threads": settings.ffmpeg_worker_threads,
            "reserved_cores": settings.RESERVED_CPU_CORES,
            "frequency_mhz": cpu_freq
        },
        "ram": {
            "total_gb": ram_total_gb,
            "used_gb": ram_used_gb,
            "free_gb": ram_free_gb,
            "percent": ram_percent,
            "reserved_system_gb": settings.reserved_ram_gb,
            "cloud_pipeline_allocated_gb": settings.pipeline_ram_gb,
            "whisper_ram_pool_gb": settings.whisper_ram_pool_gb,
            "ffmpeg_ram_pool_gb": settings.ffmpeg_ram_pool_gb,
            "streaming_buffers_gb": settings.streaming_buffers_ram_gb,
            "download_buffers_gb": settings.download_buffers_ram_gb
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
        },
        "network_geo": geo_telemetry
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
async def get_database_stats(
    request: Request,
    current_user: Dict[str, Any] = Depends(get_current_user)
):
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

    # Determine host IP or hostname for SSH tunnel or public Mongo Express
    host_header = request.headers.get("host", "localhost")
    host_ip = host_header.split(":")[0] if host_header else "localhost"
    is_public = str(settings.MONGO_EXPRESS_BIND).strip() in ["0.0.0.0", "::"]

    return {
        "database": settings.DATABASE_NAME,
        "collections": stats,
        "mongo_express_port": settings.MONGO_EXPRESS_PORT,
        "mongo_express_bind": settings.MONGO_EXPRESS_BIND,
        "mongo_express_is_public": is_public,
        "mongo_express_url": f"http://{host_ip}:{settings.MONGO_EXPRESS_PORT}/" if is_public else f"http://127.0.0.1:{settings.MONGO_EXPRESS_PORT}/",
        "ssh_tunnel_cmd": f"ssh -L {settings.MONGO_EXPRESS_PORT}:127.0.0.1:{settings.MONGO_EXPRESS_PORT} ubuntu@{host_ip}",
        "mongo_express_user": settings.MONGO_EXPRESS_USER,
        "mongo_express_pass": settings.MONGO_EXPRESS_PASS,
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
