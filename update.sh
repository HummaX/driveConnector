#!/usr/bin/env bash
# ==============================================================================
# DriveConnector - Fast Automated Update Script
# Safely pulls latest code from Git, preserves .env, and restarts containers
# Can be run from any directory or via 'driveconnector-update'
# ==============================================================================

set -e

if [ "$EUID" -ne 0 ]; then
  echo "[i] Root privileges required. Re-running script with sudo..."
  exec sudo bash "$0" "$@"
fi

# Resolve script directory (even when invoked via symlink)
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
cd "$SCRIPT_DIR"

# Source environment variables if .env exists
if [ -f .env ]; then
    set -a
    . .env 2>/dev/null || true
    set +a
fi

echo "======================================================================"
echo "    Updating DriveConnector in $SCRIPT_DIR"
echo "======================================================================"

if [ -d .git ]; then
    echo "[+] Fetching latest production code from GitHub (origin/main)..."
    git fetch origin main
    # Resets tracked files to origin/main without wiping untracked files (.env, credentials.json, token.json)
    git reset --hard origin/main
else
    echo "[!] Not a Git repository. Skipping git pull."
fi

# Ensure environment configuration is preserved or created
if [ ! -f .env ] && [ -f .env.example ]; then
    echo "[+] Creating .env from .env.example..."
    cp .env.example .env
fi

if [ -f .env ]; then
    set -a
    . .env 2>/dev/null || true
    set +a
fi

# Ensure storage directories and permissions are intact
STORAGE_DIR="${STORAGE_DIR:-/mnt/storage}"
mkdir -p "$STORAGE_DIR/mongodb" "$STORAGE_DIR/videos" "$STORAGE_DIR/metadata" "$STORAGE_DIR/config" "$STORAGE_DIR/jdownloader/cfg" "$STORAGE_DIR/jdownloader/folderwatch" 2>/dev/null || true
if [ ! -f "$STORAGE_DIR/jdownloader/cfg/org.jdownloader.extensions.folderwatch.FolderWatchExtension.json" ]; then
    cat << 'EOF' > "$STORAGE_DIR/jdownloader/cfg/org.jdownloader.extensions.folderwatch.FolderWatchExtension.json" 2>/dev/null || true
{
  "enabled" : true
}
EOF
fi
if [ ! -f "$STORAGE_DIR/jdownloader/cfg/org.jdownloader.settings.GeneralSettings.json" ]; then
    cat << 'EOF' > "$STORAGE_DIR/jdownloader/cfg/org.jdownloader.settings.GeneralSettings.json" 2>/dev/null || true
{
  "defaultdownloadfolder" : "/output"
}
EOF
fi
chown -R 1000:1000 "$STORAGE_DIR/videos" "$STORAGE_DIR/metadata" "$STORAGE_DIR/config" "$STORAGE_DIR/jdownloader" 2>/dev/null || true
chmod 775 "$STORAGE_DIR" 2>/dev/null || true
chmod -R 775 "$STORAGE_DIR/videos" "$STORAGE_DIR/metadata" "$STORAGE_DIR/config" "$STORAGE_DIR/jdownloader" 2>/dev/null || true
chown -R 999:999 "$STORAGE_DIR/mongodb" 2>/dev/null || true
chmod 750 "$STORAGE_DIR/mongodb" 2>/dev/null || true

# Ensure global update CLI shortcut is installed
chmod +x "$SCRIPT_DIR/update.sh" 2>/dev/null || true
ln -sf "$SCRIPT_DIR/update.sh" /usr/local/bin/driveconnector-update 2>/dev/null || true

echo "[+] Rebuilding and launching containers..."
docker compose up -d --build

echo "[+] Unsticking any stale processing records in database..."
docker exec media_mongodb mongosh media_db -u "${MONGO_INITDB_ROOT_USERNAME:-admin}" -p "${MONGO_INITDB_ROOT_PASSWORD:-secretpassword}" --authenticationDatabase admin --eval 'db.videos.updateMany({status: "PROCESSING", $or: [{local_path: {$ne: null}}, {file_size_bytes: {$gt: 0}}, {poster_url: {$ne: null}}]}, {$set: {status: "LOCAL_READY", processing_info: null}})' 2>/dev/null || true

echo "[+] Cleaning up dangling Docker images..."
docker image prune -f

echo ""
echo "======================================================================"
echo "    ✅ DriveConnector successfully updated and running!"
echo "======================================================================"
docker compose ps
