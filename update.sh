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

# Ensure storage directories and permissions are intact
STORAGE_DIR="${STORAGE_DIR:-/mnt/storage}"
mkdir -p "$STORAGE_DIR/mongodb" "$STORAGE_DIR/videos" "$STORAGE_DIR/metadata" 2>/dev/null || true
chown -R 999:999 "$STORAGE_DIR/mongodb" 2>/dev/null || true
chmod 777 "$STORAGE_DIR/mongodb" 2>/dev/null || true
chown -R 1000:1000 "$STORAGE_DIR/videos" "$STORAGE_DIR/metadata" 2>/dev/null || true
chmod -R 775 "$STORAGE_DIR" 2>/dev/null || true

echo "[+] Rebuilding and launching containers..."
docker compose up -d --build

echo "[+] Cleaning up dangling Docker images..."
docker image prune -f

echo ""
echo "======================================================================"
echo "    ✅ DriveConnector successfully updated and running!"
echo "======================================================================"
docker compose ps
