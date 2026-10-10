#!/usr/bin/env bash
# Stop and remove the containers, their network and the workspace volume, so the
# next up.sh starts from scratch. Only this compose project is touched.
# To pause and keep sessions and workspace instead: docker compose stop / start.
set -euo pipefail
cd "$(dirname "$0")"
docker compose down --volumes --remove-orphans "$@"
