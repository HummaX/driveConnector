#!/usr/bin/env bash
# Owner-run deployment; no privilege escalation or host provisioning.
set -Eeuo pipefail
umask 077

fail() { echo "ERROR: $*" >&2; exit 1; }
owned_directory() {
    [[ -d "$1" && ! -L "$1" ]] || fail 'Expected an ordinary owner-controlled directory.'
    local uid mode
    uid=$(stat -c %u -- "$1") || fail 'Cannot inspect directory owner.'
    mode=$(stat -c %a -- "$1") || fail 'Cannot inspect directory permissions.'
    [[ "$uid" == "$EUID" && "$mode" =~ ^[0-7]{3,4}$ ]] || fail 'Directory must belong to the executing user.'
    (( (8#$mode & 0022) == 0 )) || fail 'Directory must not be group/world writable.'
}
private_env() {
    [[ -f .env && ! -L .env ]] || fail '.env must be an ordinary owner-controlled file.'
    local uid mode
    uid=$(stat -c %u -- .env) || fail 'Cannot inspect .env owner.'
    mode=$(stat -c %a -- .env) || fail 'Cannot inspect .env permissions.'
    [[ "$uid" == "$EUID" && "$mode" =~ ^[0-7]{3,4}$ ]] || fail '.env must belong to the executing user.'
    (( (8#$mode & 0077) == 0 )) || fail 'Make .env private manually (no group/world access).'
}
cleanup() {
    local rc=$?
    trap - EXIT
    if (( rc != 0 )); then
        echo "Deployment failed during $phase. No automatic rollback was performed." >&2
        echo "Inspect Git, containers and logs. Preserve backups at ${RUN_BACKUP:-the configured backup directory}." >&2
    fi
    if (( LOCKED )); then
        rm -f -- "$HELPER"
        rmdir -- "$LOCK_DIR" || echo 'Could not release deployment lock; inspect it manually.' >&2
    fi
    exit "$rc"
}
helper() { python3 -I "$HELPER" "$@"; }
container_inventory() {
    local ids id
    ids=$(docker ps -aq --no-trunc) || return 1
    local -a all=()
    while IFS= read -r id; do
        [[ -n "$id" ]] || continue
        [[ "$id" =~ ^[a-f0-9]{12,64}$ ]] || return 1
        all+=("$id")
    done <<< "$ids"
    if (( ${#all[@]} )); then docker inspect -- "${all[@]}"; else printf '[]\n'; fi
}
check_mount() {
    [[ -d "$STORAGE" && ! -L "$STORAGE" ]] && mountpoint -q -- "$STORAGE" || fail 'Storage is not an active ordinary mount point.'
    # Also reject a symlink/non-directory MongoDB path, even on an existing installation.
    [[ ! -L "$STORAGE/mongodb" && ( ! -e "$STORAGE/mongodb" || -d "$STORAGE/mongodb" ) ]] || fail 'Unsafe MongoDB storage path.'
}
check_capacity() {
    local used=0 backup_free storage_free
    if [[ -d "$STORAGE/mongodb" ]]; then
        used=$(du --apparent-size -sk -- "$STORAGE/mongodb" | awk 'NR==1 {print $1}') || fail 'Cannot measure MongoDB data; no backup or update attempted.'
    fi
    backup_free=$(df -Pk -- "$BACKUP_DIR" | awk 'NR==2 {print $4}') || fail 'Cannot measure backup free space.'
    storage_free=$(df -Pk -- "$STORAGE" | awk 'NR==2 {print $4}') || fail 'Cannot measure storage free space.'
    helper space "$used" "$backup_free" "$storage_free" || fail 'Backup/storage capacity check failed.'
}
config_image() { "${COMPOSE[@]}" config --format json | helper config .env; }
check_existing() {
    local found
    found=$(container_inventory | helper inventory .env "$ROOT" "$INIT" "$IMAGE") || fail 'Docker inventory is unavailable, unsafe, or has concurrent users.'
    [[ "$found" == "$EXISTING" ]] || fail 'Database container state changed during deployment.'
}
# The operator must first exclude new database clients for the maintenance window.
# Include idle connections: a momentarily idle writer is not a quiesced writer.
check_clients() {
    timeout 30 docker exec media_mongodb sh -c 'exec mongosh "mongodb://127.0.0.1/admin?appName=driveconnector-deploy" --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval '\''if (db.adminCommand({ping:1}).ok !== 1) quit(2); const other=db.getSiblingDB("admin").aggregate([{$currentOp:{allUsers:true,idleConnections:true}},{$match:{client:{$exists:true},appName:{$ne:"driveconnector-deploy"}}},{$limit:1}]).toArray(); if(other.length) quit(3);'\''' >/dev/null || fail 'Cannot authenticate MongoDB, or other database clients are connected.'
}
main() {
    ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
    cd "$ROOT"
    phase=preflight LOCKED=0 RUN_BACKUP=''
    LOCK_DIR="$ROOT/.git/driveconnector-deploy.lock"
    HELPER="$LOCK_DIR/prepare_environment.py"
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP
    [[ ${EUID} -ne 0 && -z ${SUDO_USER:-} && -z ${SUDO_UID:-} ]] || fail 'Run directly as the repository owner, not root or sudo.'
    for cmd in git docker python3 mountpoint curl du df stat realpath mktemp timeout awk cp rm rmdir; do
        command -v "$cmd" >/dev/null || fail "Missing $cmd"
    done
    owned_directory "$ROOT"
    owned_directory "$ROOT/.git"
    # Atomic, per-checkout lock. Never remove an existing/stale lock automatically.
    mkdir -- "$LOCK_DIR" 2>/dev/null || fail 'Deployment lock exists or cannot be created. Check for another deployment; inspect stale locks manually.'
    LOCKED=1
    cp -- "$ROOT/scripts/prepare_environment.py" "$HELPER"
    # Git and Docker control variables may select another worktree/daemon/project.
    while IFS= read -r key; do
        case "$key" in COMPOSE_*|DOCKER_*|GIT_*) fail "Unset $key before deploying.";; esac
    done < <(compgen -e)
    helper repository "$ROOT"
    [[ $# -ge 1 ]] || fail 'Usage: bash update.sh /absolute/existing/backup-directory [--init]'
    BACKUP_DIR=$1; shift
    INIT=0
    if [[ ${1:-} == --init ]]; then INIT=1; shift; fi
    [[ $# == 0 ]] || fail 'Unknown argument.'
    [[ "$BACKUP_DIR" == /* && -d "$BACKUP_DIR" && ! -L "$BACKUP_DIR" ]] || fail 'Supply an existing absolute backup directory.'
    [[ "$BACKUP_DIR" == "$(realpath -e -- "$BACKUP_DIR")" ]] || fail 'Use a canonical backup directory without symlink components.'
    owned_directory "$BACKUP_DIR"
    if [[ ! -e .env && ! -L .env ]]; then
        (( INIT )) || fail 'Missing .env; --init is only for a genuinely empty installation.'
        STORAGE=$(helper template-storage .env.example)
        check_mount
        helper paths "$STORAGE" "$BACKUP_DIR" "$ROOT"
        helper empty "$STORAGE"
        container_inventory | helper fresh-inventory "$STORAGE" "$ROOT" || fail 'Cannot prove fresh storage/container state.'
        check_capacity
        # Prove that a private backup can be created before generating any credentials.
        RUN_BACKUP=$(mktemp -d "$BACKUP_DIR/driveconnector-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX")
        helper init .env --template .env.example
        echo 'Created fresh .env with distinct secrets; no previous file was replaced.'
    fi
    private_env
    STORAGE=$(helper storage .env)
    check_mount
    helper paths "$STORAGE" "$BACKUP_DIR" "$ROOT"
    COMPOSE=(docker compose --project-name driveconnector --project-directory "$ROOT" --env-file "$ROOT/.env" -f "$ROOT/docker-compose.yml")
    IMAGE=$(config_image) || fail 'Compose configuration validation failed.'
    EXISTING=$(container_inventory | helper inventory .env "$ROOT" "$INIT" "$IMAGE") || fail 'Cannot prove safe MongoDB state; quiesce clients and investigate manually.'
    check_capacity
    phase=backup
    if [[ -z "$RUN_BACKUP" ]]; then RUN_BACKUP=$(mktemp -d "$BACKUP_DIR/driveconnector-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX"); fi
    helper backup .env "$RUN_BACKUP"
    echo "Byte-exact private .env backup saved in $RUN_BACKUP (includes secret values; protect this directory)."
    if (( EXISTING )); then
        check_clients
        BACKUP="$RUN_BACKUP/mongodb.archive.gz"
        if ! timeout 900 docker exec media_mongodb sh -c 'exec mongodump --archive --gzip --authenticationDatabase admin --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD"' > "$BACKUP"; then
            fail 'MongoDB dump failed; incomplete backup retained. No Git update or service startup attempted.'
        fi
        helper archive "$BACKUP" || fail 'MongoDB archive/gzip validation failed; incomplete backup retained.'
        check_existing
        check_clients
        echo 'MongoDB archive signature and complete gzip integrity checked; restoration remains unverified.'
    fi
    phase=fetch
    FETCH_URL=$(helper fetch-url)
    # Explicit public URL, no credential helpers/askpass, no URL rewrites or headers.
    GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false git -c credential.helper= -c core.askPass= -c http.extraHeader= -c core.hooksPath=/dev/null -c protocol.allow=never -c protocol.https.allow=always -c fetch.fsckObjects=true fetch --no-tags --no-recurse-submodules --no-write-fetch-head "$FETCH_URL" refs/heads/claude-code:refs/remotes/origin/claude-code
    REMOTE=$(git rev-parse refs/remotes/origin/claude-code)
    [[ "$REMOTE" =~ ^[a-f0-9]{40,64}$ ]] || fail 'Invalid fetched commit identity.'
    git merge-base --is-ancestor HEAD "$REMOTE" || fail 'Local branch diverged from the fetched branch.'
    helper incoming "$REMOTE"
    # Recheck state after a possibly slow backup/fetch and before mutating the checkout.
    helper repository "$ROOT"
    helper unchanged .env "$RUN_BACKUP"
    check_mount
    check_capacity
    check_existing
    if (( EXISTING )); then check_clients; fi
    phase=update
    git -c core.hooksPath=/dev/null merge --ff-only --no-edit "$REMOTE"
    helper unchanged .env "$RUN_BACKUP"
    helper validate .env
    check_mount
    NEW_IMAGE=$(config_image) || fail 'Updated Compose configuration is unsafe.'
    [[ "$NEW_IMAGE" == "$IMAGE" ]] || fail 'MongoDB image changes require a separately reviewed migration.'
    check_existing
    if (( EXISTING )); then check_clients; fi
    phase=start
    "${COMPOSE[@]}" up -d --build
    phase=readiness
    local ready=0
    for _ in {1..30}; do
        check_mount
        helper unchanged .env "$RUN_BACKUP"
        if container_inventory | helper ready "$ROOT" 2>/dev/null && curl --noproxy '*' -fsS --connect-timeout 2 --max-time 3 http://127.0.0.1/api/ready | helper health 2>/dev/null; then
            ready=1; break
        fi
        sleep 2
    done
    (( ready )) || fail 'Application container health or backend readiness failed.'
    phase=complete
    echo "Deployment completed; all six containers and nginx-routed readiness passed. Backup: $RUN_BACKUP"
}
# Parse the function in full before fast-forward can replace this source file.
main "$@"; exit $?
