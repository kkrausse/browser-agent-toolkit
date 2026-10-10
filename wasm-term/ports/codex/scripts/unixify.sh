#!/usr/bin/env bash
# Treat WASI like unix in the given source files: rewrites `cfg(unix)` to
# `cfg(any(unix, target_os = "wasi"))`. Only for files whose unix arms use
# nothing beyond std's portable API (or std::os::fd).
for f in "$@"; do
  sed -i -E 's/cfg\(unix\)/cfg(any(unix, target_os = "wasi"))/g; s/cfg\(all\(unix, /cfg(all(any(unix, target_os = "wasi"), /g; s/cfg\(not\(unix\)\)/cfg(not(any(unix, target_os = "wasi")))/g; s/cfg!\(unix\)/cfg!(any(unix, target_os = "wasi"))/g' "$f"
done
