# DriveConnector - Self-Hosted Media Streaming & On-Demand Ingestion Platform

A high-performance self-hosted video streaming and on-demand ingestion web application designed for OVHcloud Linux servers with attached 1TB+ Block Storage volumes (`/mnt/storage`).

---

## Architecture Overview

```
                                  [ Web Browser / Client ]
                                             │
                       ┌─────────────────────┴─────────────────────┐
                       │                                           │
             HTTP Range (206) / API                         WebSocket (/ws/transfers)
                       │                                           │
                       ▼                                           ▼
          ┌─────────────────────────── FastAPI Engine ───────────────────────────┐
          │                                                                      │
          │  • HTTP Range 206 Streaming Engine (/api/stream/{video_id})          │
          │  • Real-Time Telemetry Broadcast (MB/s, ETA, Percentage)             │
          │  • RESTful API (Sync, On-Demand Download, External URL Ingestion)    │
          └─────────────┬────────────────────────────┬───────────────────────────┘
                        │                            │
             Metadata & Thumbnails Only        Heavy Media Chunks
                        │                            │
                        ▼                            ▼
               ┌─────────────────┐       ┌───────────────────────┐
               │  Google Drive   │       │  OVHcloud 1TB Storage │
               │     API v3      │       │     (/mnt/storage)    │
               └─────────────────┘       └───────────┬───────────┘
                                                     │
                                       ┌─────────────┴─────────────┐
                                       ▼                           ▼
                                /mnt/storage/videos/       /mnt/storage/metadata/
                                   ({video_id}.mp4)             ({video_id}/)
                                                                   ├── poster.jpg
                                                                   ├── preview.mp4 (4s loop)
                                                                   ├── sprites.jpg (10-col grid)
                                                                   └── thumbnails.vtt (VTT cues)
```

---

## 5 Core Features

1. **Database & Storage Architecture (MongoDB + Mongo Express UI + 1TB Block Storage)**:
   - Persistent database stored directly on `/mnt/storage/mongodb`.
   - Web-based MongoDB Admin UI on port `8081` via Mongo Express.
   - High-bitrate videos stored in `/mnt/storage/videos`.
   - Asset thumbnails, previews, and sprite sheets stored in `/mnt/storage/metadata/{video_id}/`.

2. **Lightweight Google Drive Catalog Sync (0 GB Disk Used Upfront)**:
   - Scans Google Drive for video files via Google Drive API v3.
   - Fetches file metadata and high-definition poster thumbnails (upgraded to 1280px).
   - Inserts records into MongoDB with `status: "REMOTE_ONLY"` without downloading video payloads.

3. **On-Demand Click-to-Download & External Link Ingestion with Live Progress**:
   - Clicking "Play" on a `REMOTE_ONLY` video triggers high-speed stream download directly into `/mnt/storage/videos/{video_id}.mp4`.
   - External URL Downloader supports direct MP4 links, YouTube, Vimeo, and custom video streams via `yt-dlp`.
   - Live telemetry via WebSockets (`/ws/transfers`): Speed (MB/s), MB/GB remaining, ETA, and percentage.
   - Auto-plays in the video player as soon as download completes.

4. **Automated FFmpeg Video Processing Pipeline**:
   - `poster.jpg`: High-quality frame extracted at 10% duration.
   - `preview.mp4`: 4-second muted, low-bitrate looping MP4 compiled from 4 cross-video clips for instant hover cards.
   - `sprites.jpg` & `thumbnails.vtt`: 1 frame every 5s scaled to 160x90 tiled in a 10-column sprite sheet with pixel-perfect `#xywh=` coordinates.

5. **Streaming UI & Seekbar Scrubbing Player**:
   - Video Grid with card hover video preview loops.
   - Video player with HTTP 206 Partial Content Range streaming.
   - Seekbar hover scrubbing powered by WebVTT sprites.
   - Live disk usage gauge for the 1TB Block Storage volume.

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
# Place your Google Cloud service_account.json in backend/credentials.json
```

### 3. Launch Services via Docker Compose
```bash
docker compose up -d
```

### 4. Access the Application
- **Media Streamer Web App**: `http://<SERVER_IP>:8000/`
- **Mongo Express Database UI**: `http://<SERVER_IP>:8081/` (User: `admin` / Password: `expresspassword`)
