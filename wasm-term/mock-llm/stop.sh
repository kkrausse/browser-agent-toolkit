#!/usr/bin/env bash
# Stop HOST processes listening on the wasm-term mock ports: the optional
# helpers (egress trap 4794, opencode tap 4795) and anything left over from the
# old host-side server launchers on 4791-4798. The containers are not touched
# (their ports belong to docker-proxy); use down.sh for those.
set -uo pipefail
for port in 4791 4792 4793 4794 4795 4796 4797 4798; do
  for pid in $(ss -ltnpH "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u); do
    comm="$(ps -o comm= -p "$pid")"
    [ "$comm" = "docker-proxy" ] && continue
    echo "stopping pid $pid on :$port ($comm)"
    kill "$pid" 2>/dev/null || true
  done
done
