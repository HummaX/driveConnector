# Scope and validation notes

This is a staged refactor and UI rewrite, not a complete ground-up backend rewrite. Legacy downloader, Drive, database and FFmpeg modules remain. Numerous risks are still unverified. Do not deploy to production or overwrite a live database from this archive.

Verified offline: 26 Python tests against range parsing/response generation, progress finalization, asynchronous stderr draining, real FFmpeg sprite/VTT generation, isolated JDownloader job directories, safe transcode setting, UI source structure and installer syntax; a Node DOM simulation checked catalog rendering, token-free WebSocket URLs and paused-playback continuity; JavaScript and shell syntax checks passed. These checks run without FastAPI, MongoDB, a real browser, Docker, Internet, Google credentials or JDownloader.

Not verified: real stack startup, reverse-proxy behavior, cookie behavior in browsers, codec compatibility, native player subtitle/audio selection, actual Drive sync/downloads, JDownloader permissions and folderwatch behavior, subprocess limits, resource budgeting, persistent-volume migration, authentication under outage, and full regression parity with the former React/Video.js/HTML interfaces.

External URL downloads are disabled by default pending robust network egress isolation. Existing library sizes over 1,000 are no longer silently cut off, but fetching all items at once still needs pagination for large deployments. The resource policy is soft for CPU and memory caps are not a guaranteed host reservation.

The verification script was rewritten to target the new UI. It does not run every legacy source-string check and full feature/test compatibility has not been established.

A GitHub Actions workflow has been added to run the offline checks. It has not been executed on GitHub in this session and does not perform an automatic approval or merge.
