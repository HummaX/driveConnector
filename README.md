# DriveConnector - Self-Hosted Media Streaming & On-Demand Ingestion Platform

A hardened, high-performance self-hosted video streaming and on-demand ingestion web application designed for OVHcloud Linux servers with attached 1TB+ Block Storage volumes (`/mnt/storage`).

---

## 📊 System Architecture & Data Flow Chart

```text
========================================================================================================
                          DRIVECONNECTOR END-TO-END SYSTEM DATA FLOW
========================================================================================================

 [ CLIENT BROWSER ]
   │
   ├── [ Web UI (React + Tailwind) ]
   ├── [ Plyr Video Player ]
   └── [ Real-Time Telemetry HUD Overlay ]
         │                                              ▲
         │ (1) User Actions                             │ (4) Live MB/s & ETA Telemetry
         ▼                                              │
 ┌──────────────────────────────────────────────────────┴─────────────────────────────────────────────┐
 │ FASTAPI BACKEND SERVER (Port 8000)                                                                 │
 │                                                                                                    │
 │   • JWT Authentication / RBAC (admin / Admin@Drive2026!)                                           │
 │   • Drive Catalog Sync Engine  ──────────────┐                                                     │
 │   • High-Speed Downloader Engine (yt-dlp) ───┼──────────┐                                          │
 │   • WebSocket Broadcaster (/ws/transfers) ───┤          │                                          │
 │   • HTTP 206 Partial Content Range Streamer  │          │                                          │
 └───────┬──────────────────────────────────────┼──────────┼──────────────────────────────────┬───────┘
         │                                      │          │                                  │
         │ (2) Scan Metadata Only               │          │ (3) High-Speed Stream            │
         ▼                                      │          ▼                                  │
   ┌───────────────────────────┐                │    ┌──────────────────────────┐             │
   │ GOOGLE DRIVE (API v3)     │                │    │ EXTERNAL SOURCES         │             │
   │ Remote Videos & Posters   │                │    │ YouTube, Direct MP4 links│             │
   └───────────────────────────┘                │    └──────────────────────────┘             │
                                                ▼                                             ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ OVHCLOUD 1TB BLOCK STORAGE (/mnt/storage)                                                          │
 │                                                                                                    │
 │   ├── /mnt/storage/mongodb/             <── Persistent MongoDB 7.0 Database Layer                  │
 │   │     └── videos collection           (Stores status: REMOTE_ONLY -> DOWNLOADING -> LOCAL_READY) │
 │   │                                                                                                │
 │   ├── /mnt/storage/videos/              <── Local Video Payloads ({video_id}.mp4)                  │
 │   │     └── Downloaded directly on-demand; streamed via HTTP 206 Partial Content Range            │
 │   │                                                                                                │
 │   └── /mnt/storage/metadata/{video_id}/ <── Generated Assets (FFmpeg Pipeline)                     │
 │         ├── poster.jpg                  (High-res poster from Drive / 10% frame)                   │
 │         ├── preview.mp4                 (4-second muted looping card hover preview)                │
 │         ├── sprites.jpg                 (10-column tiled scrub sheet)                              │
 │         └── thumbnails.vtt              (WebVTT timestamp mapping #xywh=x,y,w,h)                   │
 └──────────────────────────────────────────────────────▲─────────────────────────────────────────────┘
                                                        │
                                                        │ (5) Background Process Job
                                          ┌─────────────┴───────────────┐
                                          │ ASYNC FFMPEG WORKER PIPELINE│
                                          │ Throttled Concurrency (x2)  │
                                          │ Timeout Guarded (180s)      │
                                          └─────────────────────────────┘
```

---

## 🔀 Git Versioning & Pull Request Approval Protocol

```text
========================================================================================================
                          GIT VERSIONING & PR APPROVAL PROTOCOL
========================================================================================================

  [ 1. DEVELOP ]
       User Request / Bug Report
                  │
                  ▼
       git checkout -b <type>/<description> (feat/ or fix/)
                  │
                  ▼
       Write Clean Code + Verify Local Syntax & Tests
                  │
                  ▼
       git commit -m "feat/fix: descriptive summary"

  [ 2. REVIEW GATE ]
                  │
                  ▼
       git push -u origin <branch-name>
                  │
                  ▼
       Open GitHub Pull Request (PR)
                  │
                  ▼
         ┌─────────────────────────────────┐
         │     USER APPROVAL GATE          │
         │  (Reviewed & approved in chat)  │
         └────────────────┬────────────────┘
                          │
            Approved? ────┴──── No ──> Revise on Branch
            │ (Yes)
            ▼
  [ 3. RELEASE ]
       Merge Pull Request into 'main'
                  │
                  ▼
       Tag Semantic Version (e.g. v1.1.0, v1.2.0, v1.2.1)
                  │
                  ▼
       Publish Official GitHub Release
                  │
                  ▼
       Deploy on OVHcloud Server: sudo bash update.sh
========================================================================================================
```

---

## 🔑 Default Admin Credentials

When the system boots for the first time, an administrator account is automatically created in MongoDB:

- **Username**: `admin`
- **Password**: `Admin@Drive2026!`
- **Role**: `admin`

*(You can customize these defaults anytime in `.env` via `ADMIN_USERNAME` and `ADMIN_DEFAULT_PASSWORD`)*.

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

### Option A: One-Command Automated Setup (Recommended)

Run this single command inside the cloned `driveConnector` directory. It automatically installs Docker, configures storage permissions, sets up `.env`, pulls the latest code, and boots the entire platform:

```bash
sudo bash setup.sh
```

*(Or without cloning first)*:
```bash
curl -fsSL https://raw.githubusercontent.com/HummaX/driveConnector/main/setup.sh | sudo bash
```

### Option B: Manual Setup

```bash
# 1. Mount & prepare 1TB block storage
sudo mkdir -p /mnt/storage/mongodb /mnt/storage/videos /mnt/storage/metadata
sudo chown -R 999:999 /mnt/storage/mongodb
sudo chown -R 1000:1000 /mnt/storage/videos /mnt/storage/metadata

# 2. Configure environment
cp .env.example .env

# 3. Launch stack
docker compose up -d --build
```

### Updating the Server

Whenever a new release or update is approved, update your live server with:

```bash
sudo bash update.sh
```

---

## ☁️ Connecting Google Drive via UI

DriveConnector allows you to connect your Google Drive directly from your web browser without touching server configuration files.

### Option 1: Google Drive API Key (Fastest & Free — 2 Minutes)
Best for public or shared Google Drive folders (**Anyone with the link can view**).

1. Go to **[Google Cloud Console](https://console.cloud.google.com/)**.
2. Create a new project (e.g. `DriveConnector`) or select an existing one.
3. In the search bar, search for **Google Drive API** and click **Enable**.
4. In the left navigation, go to **APIs & Services > Credentials**.
5. Click **+ CREATE CREDENTIALS** at the top and choose **API key**.
6. Copy your API Key (`AIzaSy...`).
7. In Google Drive, open the folder containing your videos, right-click > **Share** > set General access to **Anyone with the link** (Viewer).
8. In DriveConnector UI, click **Sync Drive** in the navbar:
   - Paste your **API Key**.
   - Paste your **Folder Link or ID** (Required for API Key since it queries public folders; subfolders inside are automatically traversed).
   - Click **Test Connection** to verify live connectivity and folder accessibility.
   - Click **Start Sync** to catalog all video metadata and poster thumbnails!

### Option 2: Service Account JSON (For Private Drives)
For private corporate or personal Google Drive folders:
1. In Google Cloud Console, navigate to **IAM & Admin > Service Accounts**.
2. Click **Create Service Account**, name it, and click Done.
3. Click on the newly created Service Account > **Keys** tab > **Add Key > Create new key > JSON**.
4. In Google Drive, share your target folder with the Service Account's email address (`xxx@project.iam.gserviceaccount.com`).
5. In DriveConnector UI, click **Sync Drive** > switch to the **Service Account JSON** tab:
   - Paste the JSON key (or click **Upload .json**).
   - Click **Test Connection** and **Start Sync**.

---

## 🤖 Automated PR Review & CI Pipeline

Every Pull Request can be automatically reviewed and pushed using the automated PR tool (`scripts/auto_pr.py`) and GitHub Actions CI (`ci/auto-review.yml`):

1. **Pre-flight Syntax & Security Checks**: Compiles Python bytecode and audits for syntax errors before pushing.
2. **Automated Remote Push & PR Creation**: Automatically pushes the feature branch and creates the Pull Request on GitHub with a comprehensive description.
3. **Automated Code Review Generation**: Automatically submits a structured security and quality checklist review comment on the PR.
4. **Auto-Merge Capability**: Automatically merges verified PRs into `main` via squash merge when `--auto-merge` is passed.

### Quick Auto-PR Utility

To automatically review, push, and open a Pull Request with an automated review report:

```bash
# Push branch, open PR, and generate automated review:
python scripts/auto_pr.py --title "feat: descriptive title" --body "Summary of changes"

# Push, review, and auto-merge in one step:
python scripts/auto_pr.py --title "feat: descriptive title" --auto-merge
```

### GitHub Actions CI Workflow

The workflow template in `ci/auto-review.yml` can be placed into `.github/workflows/auto-review.yml` for automatic cloud-based Bandit security audits, Flake8 linting, and Vite frontend builds on every GitHub pull request.

