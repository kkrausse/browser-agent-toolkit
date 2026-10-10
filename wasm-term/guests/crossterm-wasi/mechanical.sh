#!/usr/bin/env bash
# Step 1 of the wasi port, kept mechanical so it re-applies to any crossterm
# revision: everywhere the crate says "unix" it means "has a tty with termios
# and ANSI input", which is also true of wasm-term. Windows-only files and the
# mio event source (not used on wasi) are left alone.
set -euo pipefail
cd "$1"
find src -name '*.rs' -not -path '*/windows/*' -not -name 'windows.rs' -not -path 'src/event/source/unix/mio.rs' -print0 |
  xargs -0 sed -i -E \
    -e 's/cfg\(unix\)/cfg(any(unix, target_os = "wasi"))/g' \
    -e 's/all\(unix, /all(any(unix, target_os = "wasi"), /g'
