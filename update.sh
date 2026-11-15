#!/usr/bin/env bash
# Rebuild only the currently checked-out and reviewed files. No Git resets or merges.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
docker compose config -q
docker compose up -d --build
docker compose ps
