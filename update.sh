#!/usr/bin/env bash
# Direct owner-run entrypoint; no automatic rollback or host maintenance.
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec bash "$HERE/scripts/deploy_claude.sh" "$@"
