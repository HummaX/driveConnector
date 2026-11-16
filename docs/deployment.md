# Owner-run deployment helper (Ubuntu)

## Supported entrypoints and prerequisites

Run the checked-in wrappers **directly as the checkout owner**, not as root, through `sudo`, from a downloaded installer, or via an installed system command:

```bash
bash /absolute/path/to/checkout/update.sh /absolute/path/to/existing/backup-directory
```

The checkout must already be a clean, ordinary Git repository on `claude-code`, with an ordinary owner-controlled `.git` directory and no additional linked worktrees or unfinished Git operations. Resolve tracked/untracked changes yourself. The helper never switches branches, stashes, resets, force-fetches, edits remotes, or force-pushes. Review and trust the incoming branch before running: a fast-forward and Compose build execute that branch's code. Hooks are disabled for the helper's Git mutation commands.

Provision Git, Bash, Python 3, Docker Compose v2, Docker access for this owner, GNU coreutils (`stat`, `realpath`, `mktemp`, `timeout`, `du`, `df`), `mountpoint`, `awk`, and curl independently. The helper does not install software, grant Docker privileges, mount/format disks, provision cgroups, change ownership/permissions, install aliases, or remove images, containers, volumes or backups. Docker access is itself powerful; this script is not a security boundary against a hostile owner or daemon.

Use an already mounted, canonical absolute `STORAGE_DIR`, an existing owner-controlled backup directory outside both the checkout and storage, and sufficient free space. The checkout, `.git`, and backup directory must be owned by the executing user and not group/world writable. `.env` must be an owner-owned regular file with one link, no group/world permissions, and no symlink. Fix any permissions **manually**; the helper will not change them. An owner unable to list/measure Docker-owned database files cannot safely use this helper: arrange a reviewed owner-readable backup arrangement separately, not a sudo rerun.

Only the default local Docker configuration is supported. Unset `DOCKER_*`, `COMPOSE_*`, `GIT_*` environment controls and all shell variables referenced by Compose or dotenv. The fixed Compose project is `driveconnector`. Existing containers must identify the same project, service and checkout through their Compose labels. A `.git` file, foreign owner, foreign container, alternate context/daemon or ambiguous configuration is rejected.

## Mandatory maintenance window

**Before an existing update, manually stop application clients, including backend, media-worker, Mongo Express, JDownloader and nginx, but leave the original MongoDB container running.** Do not use a command that removes the database container or volumes. Close Mongo shells, dashboards, host services and other external database clients. Ensure no new clients or writers can connect for the entire backup/update window; arrange access isolation independently.

The helper does not stop clients automatically. It refuses other running containers sharing MongoDB storage or its network, unknown containers referencing its storage, and foreign application containers. It authenticates against MongoDB using the existing in-container configuration and rejects other connections, including idle connections, using `$currentOp`. It checks again after the dump and immediately around the fast-forward/startup steps. Daemon/listing/authentication errors are failures, never evidence of an empty installation.

These checks detect observed clients; **they do not fence new connections or create an atomic snapshot**. An operator-controlled exclusive maintenance window is essential for the standalone MongoDB logical dump. If that cannot be guaranteed, do not deploy with this helper. Arrange and test a database-specific consistent backup procedure separately. There is no fsync write-lock, automatic stop, replica-set oplog guarantee or full restore verification here.

## Configuration and credentials

Retain the original `.env` and **all original MongoDB credentials/database names** for an existing installation. The helper never sources dotenv, rewrites an existing file, rotates credentials or repairs database users. It rejects missing, duplicate or ambiguous entries, shell/interpolated/quoted syntax, known legacy default secrets and Mongo URL components outside URL-unreserved characters. Known defaults remain intentionally rejected; migrate them through a separately reviewed procedure that preserves access before using this entrypoint. Do not replace passwords in dotenv as a substitute for migrating actual MongoDB users.

The resolved Compose database mount, database image, MongoDB credentials, backend/worker database URL and database name, application credentials and storage must agree with the validated configuration. An image change needs a separate migration. Incoming tracked `.env` or collisions with ignored local files abort the fast-forward. The helper snapshots its validator under the lock so the same checks remain in effect even if Git updates the source during this run.

Origin must be a **single public, token-free HTTPS `.git` URL**, with no userinfo, query or fragment. URL rewriting, configured HTTP authorization headers and Git proxy configuration are unsupported. Configure these manually beforehand; the helper does not strip tokens or change remotes. Fetch uses the explicit validated URL with credential helpers and prompts disabled, without force or tags. A private repository requiring credentials is intentionally unsupported by this entrypoint. No remote access occurs in the fixture tests.

## Backups, capacity and locking

Each accepted run creates a private, unique backup subdirectory. Before fetching or updating it writes a byte-exact `.env` copy and non-secret identity metadata; it checks the source bytes, inode, ownership, mode and timestamp again before/after the update and during readiness. The original file is not chmodded, chowned or rewritten. Backup copies are owned by this same executing owner; they are private secret-bearing files and must be protected.

For an existing deployment, the helper also creates an authenticated `mongodump --archive --gzip` backup, with a 15-minute timeout. Dump failures, truncated/invalid gzip streams and missing MongoDB archive signatures abort without fetching/updating/starting services; incomplete backup files remain for inspection. Archive signature and gzip integrity are not a successful restore test. Keep separately tested backups of media, Google credentials/tokens and any other persistent configuration: this helper does not copy those files.

The backup filesystem must have **more than twice** the readable apparent MongoDB directory size plus 100 MiB free; storage must have more than 100 MiB free. Failed `du`/`df` measurements abort. This is a conservative estimate, not a bound on dump size or Docker build space: live growth, metadata and competing processes can still exhaust disk space. Write errors fail the deployment and retain partial backups. Monitor both filesystems and Docker's own image/build storage independently. Backups on the same physical device are not disaster protection, and an unmounted backup destination cannot be detected without a separately managed mount policy.

An atomic directory lock at `.git/driveconnector-deploy.lock` excludes simultaneous helper runs in this checkout. Normal exits/signals release only the acquired lock. An existing lock is never removed or bypassed; after a crash, first prove the previous process has ended and then inspect/remove its stale lock manually. This is not a machine-wide database lock: multiple checkouts/processes and external clients require the exclusive maintenance controls above.

## Fresh installation and safe retries

For a genuinely new installation, pre-provision storage at the template's `STORAGE_DIR`, ensure its `mongodb` directory is absent or provably readable/empty, and ensure no prior MongoDB container exists. Then run:

```bash
bash /absolute/path/to/checkout/setup.sh /absolute/path/to/existing/backup-directory --init
```

The entire template is validated before exclusive creation. Blank secret entries receive independent random values, and `.env` is created with mode 600 without replacing any previous file. Storage, empty-directory inspection, daemon inventory and backup-directory creation must succeed first. A listing permission error is not an empty directory.

If an initial attempt fails **before any MongoDB container/data is created**, resolve the cause and retry the same `--init` command. An existing valid `.env` is reused byte-for-byte, not regenerated, but emptiness/container checks still apply. If MongoDB now exists, `--init` is refused: preserve its credentials and follow the existing-installation procedure with the original database running. A partial/invalid dotenv write requires manual recovery; do not delete configuration or data merely to make initialization pass.

## Readiness and recovery

After Compose startup, the helper requires all six expected project containers to be running, not restarting/dead, and healthy when a healthcheck exists. It then checks nginx-routed `http://127.0.0.1/api/ready`, bypassing proxies, requiring HTTP success and `status=ok`, `app=drive_connector`, `database=ok`, `worker=ok`. The worker/database readiness contract is deliberately stronger than the old process-only `/api/health`. Thirty bounded probes allow startup retries; storage and dotenv identity are rechecked. This does not validate OAuth, media jobs, JDownloader's UI, disaster recovery, host resource enforcement or all external dependencies.

Failures identify their phase and backup directory. No automatic Git/container/data rollback occurs. Failure after fast-forward or Compose startup may leave new code and partially updated services running. Preserve logs, original credentials and backups, inspect actual state, and use a separately rehearsed manual recovery procedure. A successful fresh deployment can later be updated only using the normal existing-installation maintenance window.

## Isolated verification and deliberate legacy incompatibility

Run tests from a scratch copy containing the helper, wrappers, template and tests, never from a live deployment:

```bash
python -I -m unittest discover -s /absolute/scratch/tests -p test_deployment_helper.py -v
bash -n /absolute/scratch/scripts/deploy_claude.sh
```

The suite retains the original three dotenv tests and adds synthetic Git/Docker/mount/free-space integration fixtures, backup/readiness/failure checks, a two-process lock test, and directory-listing error injection. Commands are intercepted through a temporary fixture-only PATH; no actual Docker daemon, remote, block storage, mount operation or production configuration is used. On root-only test hosts, owner-run shell integration tests intentionally skip rather than weaken the root rejection. Windows may skip the symlink test because creating symlinks requires privileges. Passing fixtures do not certify Ubuntu file ownership, real Mongo shell behavior/restore, actual Docker/Compose or a mounted filesystem.

The unchanged original `scripts/verify_dashboard.py::test_deployment_and_mongo_express_ux` requires automatic disk mounting, cloning outside a repository, installing a system updater link and image pruning. Those operations are intentionally absent, so that legacy check fails. Comments no longer masquerade as implementations to satisfy substring assertions. Neither that verifier nor its original tests are modified; unsafe operations are not added solely to make it pass.
