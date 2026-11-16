#!/usr/bin/env bash
# Direct owner-run entrypoint; prerequisites must already be provisioned.
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec bash "$HERE/scripts/deploy_claude.sh" "$@"
