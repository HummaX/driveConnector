# DriveConnector — experimental rebuild

A self-hosted media library for an Ubuntu server, using FastAPI, MongoDB, Google Drive, FFmpeg, JDownloader and an HTTP-only Nginx reverse proxy. The new canonical interface is the static frontend in `frontend/index.html`, `frontend/login.html`, `frontend/css/app.css` and `frontend/js/`. No frontend build or external JavaScript CDN is required.

> **This is an experimental candidate, not a production-ready release.** It was developed offline using the existing local source. The frontend is new; the original downloader, Drive catalog and FFmpeg engines have been retained and selectively refactored, not rewritten completely. Live Docker, MongoDB, Google Drive, JDownloader and browser-to-server tests have not been run. Keep a full backup and test on a disposable staging server before considering deployment.

## What changed

The library now centers the actual media catalog, provides search, filters, sorting, Drive connection, storage scanning, transfers, a native browser player, thumbnail-sprite scrubbing, alternate audio, subtitles, a quality selector and Web Audio gain. Processing completion updates the active player without automatically resuming or recreating it. The original React application and the second built-in HTML UI are intentionally not included.

The backend retains the existing database model and most API paths. Authentication supports an HttpOnly, SameSite cookie for the new UI and retains bearer authorization for API clients. Media metadata requires authentication. The 206 streaming code shares a byte-range parser, handles suffix ranges correctly and does not log tokens in Nginx URLs. The installer no longer formats disks or resets Git, and replacement of original media during transcoding is disabled.

The supplied MongoDB and JDownloader web interfaces are bound to localhost on ports 8081 and 5800. The backend is bound to localhost on port 8000 and Nginx listens on port 80. An explicit disk mount is required by the setup script.

## Security boundaries

* **HTTP is unencrypted.** Passwords, cookies and media can be intercepted on the network. Use the app only via a trusted network, VPN or SSH tunnel. The server intentionally has no SSL or custom-domain setup.
* External URL ingestion is **disabled by default** (`ENABLE_EXTERNAL_URLS=false`). The retained external engines may follow redirects, resolve destinations again, or fetch secondary URLs. Initial URL checks alone do not prevent SSRF or DNS rebinding. Do not enable this until outbound network isolation is implemented and verified; the Add video dialog will report that the feature is disabled.
* Existing MongoDB volumes do **not** change their root credentials when `.env` changes. The initial application admin password is used only when creating a new admin record; changing the environment variable later does not reset an existing account. Changing the JWT key invalidates existing tokens.
* Drive API keys, OAuth credentials and service-account JSON are still stored in the MongoDB settings collection. Protect the database and its backups. Logout removes the browser cookie; already issued bearer tokens are not immediately revoked.
* Authentication, metadata access, egress controls, account recovery, dependency versions and the FFmpeg pipeline still need a full security review and live integration tests. Use this build only in a staging environment.

## Staging setup

1. Back up the database, application configuration and `/mnt/storage`; test restoration. Preserve the current `.env` separately. Do not copy a staging database over production.
2. Install Docker Engine and Docker Compose on Ubuntu 24.04. Mount the intended block device at `/mnt/storage` **before** running setup. The script never formats or mounts a disk.
3. For a new isolated deployment, run `./setup.sh`. If `.env` is absent it generates unique credentials, stored in `.env` (file permissions 0600); the initial admin password is the `ADMIN_DEFAULT_PASSWORD` value in that file. Review the values privately. If `.env` already exists, it is not regenerated.
4. For an existing database, reconcile `.env` with its real MongoDB credentials first and provide a unique `JWT_SECRET_KEY` of at least 32 characters. Percent-encode MongoDB credentials containing URL-reserved characters or use generated hexadecimal passwords. Do not assume a changed admin environment value resets a MongoDB user.
5. Check volume permissions, run `docker compose config`, then on **staging only** run `docker compose up -d --build`. Open `http://<server-ip>/` through a trusted network. The stack intentionally does not configure TLS.

To access local-only administration tools, establish tunnels from your own computer using your actual server username and address:

```sh
ssh -L 8081:127.0.0.1:8081 -L 5800:127.0.0.1:5800 user@server
```

Then visit `http://127.0.0.1:8081/` or `http://127.0.0.1:5800/` locally. `update.sh` only rebuilds the currently checked-out files; it does not fetch, reset or merge Git branches.

## Resource limits

Compose sets conservative per-container memory limits totaling about 25.75 GiB for the five services. This can leave headroom on a 32 GB host, but it is **not a guaranteed 10% reservation**: host memory, page cache, the exact available RAM, cgroup enforcement and other processes all matter. Confirm actual cgroup values and measure peak usage on the target host. FFmpeg and Whisper calculate a per-job thread budget from visible CPUs, a reserved-core setting and the configured worker concurrency. This is a soft concurrency policy, not CPU pinning or a hard reservation; FFmpeg libraries and concurrent non-worker workloads can use additional threads. A separate worker service with cgroups/CPU affinity and load testing is still needed for a strict N−1 budget.

## Verification

```sh
python3 scripts/verify_dashboard.py
```

The rewritten verifier tests the canonical UI rather than the removed legacy UI. It runs Python unit tests for byte ranges, response body handling, progress and job isolation; a mocked frontend smoke test for catalog rendering and paused-playback continuity; JavaScript syntax checks; and shell syntax checks. It does **not** establish full compatibility with every old feature or substitute for the original legacy-specific verification suite. The old suite referenced the removed React and standalone HTML implementations, so it was not retained unchanged.

Before any release, install the actual application dependencies and add/run integration tests covering authentication and cookies, metadata authorization, real FastAPI 200/206/416 and HEAD responses, all Drive authentication methods, storage migration, the JDownloader folder watcher, real ffmpeg/ffprobe processing, subtitle generation, browser codecs, seek/scrub/track switching, restart recovery, concurrent downloads, 32 GB resource limits and load while playing video.

## Git workflow

This archive contains no `.git` directory and is not pushed anywhere. Apply changes only after inspection and preserve existing uncommitted work. Use the project's `claude` branch and obtain approval before merging to `main`.
