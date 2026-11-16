# Experimental rebuild status

## Release gate: blocked

This working-tree candidate starts from `main` at
`d46327758de27f88e1d59bf9e07a457d5b533044` and is developed only on
`claude-code`. No merge into `main`, server deployment, or production data
migration was performed. This is a selective compatible rebuild, **not a
completed from-scratch rewrite or a production-ready release**.

The unchanged legacy verifier currently passes **26 of 27 checks**. Its
`test_deployment_and_mongo_express_ux` requires installer auto-mount support,
clone fallback, a system updater symlink and image-pruning markers. Those
behaviors are deliberately absent from the safer owner-run helper. The verifier
has not been changed, skipped, or padded with inert marker comments to hide the
incompatibility. Publishing as a completed release is blocked by this gate.

## Implemented changes

- Matching frontend and backend-static HTML, one active inline application
  engine, a library-first screening-room layout, real list mode, accessible
  controls, browser-local timestamp bookmarks and paused quality-switch
  continuity. Legacy React source contracts remain present.
- Private authenticated metadata; server-issued media cookies and logout;
  no database-offline administrator fallback or credential responses from the
  database administration API. Existing password hashes are retained.
- Shared GET range handling, suffix ranges that reach EOF, bounded reads,
  consistent 416 responses and full-representation HEAD responses.
- Durable bounded Mongo-backed media jobs, separate worker service, atomic
  per-video running ownership, explicit stalled-lease recovery, subprocess
  isolation, cross-process progress snapshots and dependency readiness.
  Deletion uses the same ownership index as media work. Verified published
  downloads/renditions can recover after a catalog write fails.
- Safer subprocess pipe draining, conservative completion states, preserved
  original media, explicit rejection of original-file replacement and default
  disabling of external URL ingestion with incomplete egress isolation.
- A strict owner-run Ubuntu update helper with private environment/database
  backups, clean-tree and collision checks, exclusive maintenance requirements,
  mount/capacity/container checks, non-forced fast-forward updates and readiness
  polling. It does not format/mount disks, reset/stash Git changes, rotate
  credentials, recursively change permissions, or delete volumes/images.

## Verification scope

All verification uses synthetic files, temporary storage and fake persistence or
external command boundaries, not production credentials, database or storage.
The legacy suite runs against a disposable source snapshot with network/DNS
blocked. Its Mongo boundary is an in-memory adapter; handlers and queue APIs
remain the production implementations. The suite does not execute application
startup, real Google operations, real MongoDB leases or real transcoding.

| Targeted suite | Latest standalone result |
| --- | --- |
| Authentication regressions | 5 passed |
| Byte-range parsing | 5 passed |
| Actual HTTP response/generator behavior | 6 passed |
| Metadata path containment | 2 passed, 1 Windows symlink-permission skip |
| Media queue, shutdown, publication and recovery | 17 passed |
| Synthetic cgroup diagnostics | 11 passed |
| Frontend contracts and isolated Chromium interaction | 5 passed |
| Stubbed deployment preservation/failure paths | 48 passed, 1 Windows symlink-permission skip |

The deployment fixture run exercises both success paths, byte-preserved secrets,
backup-before-fetch ordering, missing/foreign mounts, dirty/divergent Git state,
failed/corrupt backup, unsafe ownership, failed readiness, retryable fresh
initialization and concurrent helper exclusion. Git, Docker, mount and space
commands are synthetic stubs. The browser test executes extracted control logic
with a fresh profile and network-denying CSP; it is not full Video.js playback.

Python and shell syntax, Compose YAML structure, shared web/worker environment,
HTML byte equality and Git patch whitespace have also been checked. YAML parsing
is **not** an actual Docker Compose validation/build.

Run the network/process-denying verification envelope with:

```bash
python -I -B tests/run_isolated_verifier.py
```

It intentionally reports the unchanged legacy deployment failure. Browser,
Bash-integration and stderr-child cases are skipped *within that restrictive
envelope* and exercised separately by their audited synthetic standalone suites.
Original legacy checks are not skipped. Logs, snapshot hashes and source-drift
manifests are written to a unique temporary directory printed by the runner.

## Known incomplete or intentionally restricted behavior

1. **No aggregate host CPU or memory reservation.** Diagnostics and UI explicitly
   report estimates, not enforcement. No systemd/cgroup provisioning script was
   installed. A quota alone would not reserve a physical core, and a 90% cap
   would not guarantee 10% free host RAM. On-demand audio/track extraction still
   runs in the web process.
2. **Legacy frontend union is incomplete.** These 16 baseline IDs remain absent:
   `audio-boost-btn`, `globe-active-conns`, `globe-client-ip-text`,
   `globe-countries-badge`, `globe-countries-flags`, `globe-latency-text`,
   `globe-server-node-text`, `hero-globe-container`, `modal-url-input`,
   `player-download-overlay`, `player-scrub-preview`, `player-scrub-thumb`,
   `player-scrub-time`, `root`, `transfers-container`, `video-empty-state`.
   Passing self-reference checks does not prove the full legacy DOM contract.
3. **Worker-integrated JDownloader dispatch is refused.** The separate service
   cannot be proven stopped as part of an isolated job, so the durable worker
   does not claim safe cancellation/retry for it. Its localhost manual desktop
   remains in Compose. External URL ingestion is disabled by default.
4. **Deployment prerequisites are intentionally strict.** Existing known default
   secrets, ambiguous quoted/interpolated dotenv, private/credential-bearing
   origins, linked worktrees and inaccessible database directories are refused,
   not repaired. The helper requires a clean checkout already on `claude-code`
   and a manually arranged exclusive maintenance window. It does not switch an
   existing `main` deployment automatically.
5. **Live integration remains unverified.** No actual Ubuntu Docker startup,
   real MongoDB concurrency/index migration, backup restoration, Google Drive
   ingestion, JDownloader watcher, real browser-to-server playback, security
   penetration testing, cgroup enforcement or resource-load test was performed.

Read [the deployment procedure and refusal conditions](deployment.md) and
[resource-governance limitations](resource-governance.md) before any server use.
Do not bypass the release gate or treat a fixture pass as live readiness.
