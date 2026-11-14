#!/usr/bin/env bash
# ==============================================================================
# DriveConnector - Fast Automated Update Script
# Pulls latest code from Git and restarts containers with updated builds
# ==============================================================================

set -e

if [ "$EUID" -ne 0 ]; then
  echo "[i] Root privileges required. Re-running script with sudo..."
  exec sudo bash "$0" "$@"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "[+] Pulling latest code from GitHub..."
git fetch origin main
git reset --hard origin/main

echo "[+] Rebuilding and launching containers..."
docker compose up -d --build

echo "[+] DriveConnector updated and running!"
docker compose ps
