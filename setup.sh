#!/usr/bin/env bash
# Non-destructive preparation. Never formats disks, wipes storage, or resets Git.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
command -v docker >/dev/null || { echo 'Docker with the Compose plugin is required.' >&2; exit 1; }
docker compose version >/dev/null || { echo 'Docker Compose plugin is required.' >&2; exit 1; }
if [ ! -f .env ]; then
    OLD_UMASK=$(umask)
    umask 077
    python3 - <<'PY'
from pathlib import Path
from secrets import token_hex
sample = Path('.env.example').read_text()
for key in ('MONGO_INITDB_ROOT_PASSWORD', 'MONGO_EXPRESS_PASS', 'ADMIN_DEFAULT_PASSWORD', 'JDOWNLOADER_PASSWORD'):
    sample = sample.replace(f'{key}=\n', f'{key}={token_hex(20)}\n')
sample = sample.replace('JWT_SECRET_KEY=\n', f'JWT_SECRET_KEY={token_hex(32)}\n')
Path('.env').write_text(sample)
PY
    umask "$OLD_UMASK"
    echo 'Created .env with unique credentials. Keep this file safe; the initial admin password is ADMIN_DEFAULT_PASSWORD.'
else
    echo 'Using existing .env; existing credentials were not changed.'
fi
# Use Compose interpolation rather than sourcing the .env as executable shell code.
STORAGE_DIR_VALUE=$(docker compose config --format json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["services"]["backend"]["environment"]["STORAGE_DIR"])')
if ! mountpoint -q "$STORAGE_DIR_VALUE"; then
    echo "Storage path $STORAGE_DIR_VALUE is not a mount point. Mount the intended volume before continuing." >&2
    echo 'No disk was formatted or mounted by this script.' >&2
    exit 1
fi
for dir in mongodb videos metadata config jdownloader jdownloader/cfg jdownloader/folderwatch; do
    if [ ! -d "$STORAGE_DIR_VALUE/$dir" ]; then
        mkdir -p "$STORAGE_DIR_VALUE/$dir"
        if [ "$(id -u)" -eq 0 ]; then
            if [ "$dir" = mongodb ]; then chown 999:999 "$STORAGE_DIR_VALUE/$dir"; else chown 1000:1000 "$STORAGE_DIR_VALUE/$dir"; fi
        fi
    fi
done
FW="$STORAGE_DIR_VALUE/jdownloader/cfg/org.jdownloader.extensions.folderwatch.FolderWatchExtension.json"
GENERAL="$STORAGE_DIR_VALUE/jdownloader/cfg/org.jdownloader.settings.GeneralSettings.json"
if [ ! -e "$FW" ]; then printf '{"enabled": true}\n' > "$FW"; fi
if [ ! -e "$GENERAL" ]; then printf '{"defaultdownloadfolder": "/output"}\n' > "$GENERAL"; fi
if [ "$(id -u)" -eq 0 ]; then chown 1000:1000 "$FW" "$GENERAL"; fi
echo 'Check that the MongoDB and JDownloader containers can write to their directories.'
echo 'Review .env and the README. Then start with: docker compose up -d --build'
