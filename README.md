# DriveConnector - Self-Hosted Media Streaming & On-Demand Ingestion Platform

A hardened, high-performance self-hosted video streaming and on-demand ingestion web application designed for OVHcloud Linux servers with attached 1TB+ Block Storage volumes (`/mnt/storage`).

---

## Default Admin Credentials

When the system boots for the first time, an administrator account is automatically created in MongoDB:

- **Username**: `admin`
- **Password**: `Admin@Drive2026!`
- **Role**: `admin`

*(You can customize these defaults anytime in `.env` via `ADMIN_USERNAME` and `ADMIN_DEFAULT_PASSWORD`)*.

---

## Security & Architectural Hardening Implemented

1. **Cybersecurity Protections**:
   - **SSRF & LFI Defense**: All external URLs ingested through `yt-dlp` are validated via DNS resolution. Private IPs, loopbacks, link-local addresses, and cloud metadata endpoints (`169.254.169.254`) are strictly blocked.
   - **JWT Authentication & RBAC**: Core write operations (Drive sync, video deletion, external URL downloads, on-demand fetching) require a valid signed JWT Bearer token.
   - **XSS Sanitization**: Dynamic user/video data in the Web UI is escaped through an `escapeHtml()` entity encoding pipeline.
   - **Path Traversal Protection**: Video identifiers are validated with regex `^[a-zA-Z0-9_-]{1,64}$` to prevent directory traversal attacks on disk.
   - **MongoDB ReDoS Defense**: Search terms are escaped via `re.escape()` before being used in regex queries.

2. **Operational & Linux Hardening**:
   - **MongoDB Isolation**: Ports `27017` and `8081` are bound to `127.0.0.1` in `docker-compose.yml`, preventing public exposure on the OVHcloud server's public IP.
   - **Storage Pre-Check**: Pre-checks free disk space before downloads start to prevent disk exhaustion.
   - **Atomic File Operations**: Partial downloads write to temporary `.part` files and rename atomically on completion, with auto-cleanup on failure.
   - **PID 1 Zombie Reaping**: Docker container uses `tini` as init system to reap orphan FFmpeg and yt-dlp child processes.
   - **FFmpeg Concurrency Semaphore**: Throttles concurrent background transcode/sprite generation jobs.

3. **Code & Concurrency Fixes**:
   - **Download Lock**: `_download_lock` prevents concurrent requests from clobbering the same file handle.
   - **RFC 7233 Range Streaming**: Full support for clamped byte bounds, start-only, and suffix-byte ranges (`bytes=-500`).
   - **Atomic Upserts**: MongoDB upserts use `update_one(..., upsert=True)` with unique sparse indexes to eliminate check-then-act race conditions.

4. **UI & Player Lifecycle**:
   - **Stable WebSocket Lifecycle**: Decoupled from modal open/close states to prevent reconnection storms.
   - **Non-Destructive Scrubbing**: Plyr player maintains continuous playback at the active timestamp when background sprite sheets finish processing.

---

## Quick Start on OVHcloud Linux Server

### 1. Mount & Prepare 1TB Block Storage
```bash
sudo mkdir -p /mnt/storage/mongodb /mnt/storage/videos /mnt/storage/metadata
sudo chown -R 1000:1000 /mnt/storage
```

### 2. Configure Environment & Credentials
```bash
cd driveConnector
cp .env.example .env
```

### 3. Launch Services via Docker Compose
```bash
docker compose up -d --build
```

### 4. Access the Application
- **Media Streamer Web App**: `http://<SERVER_IP>:8000/`
  - Click **Sign In** with Username `admin` / Password `Admin@Drive2026!`
- **Mongo Express Database UI**: Accessible locally at `http://127.0.0.1:8081/` (or via SSH tunnel: `ssh -L 8081:localhost:8081 user@<SERVER_IP>`)
