#!/usr/bin/env bash
# Like unixify.sh but only on the given line numbers of one file.
# usage: scripts/unixify-line.sh <file> <line>...
f="$1"; shift
for l in "$@"; do
  sed -i -E "${l}s/cfg\(unix\)/cfg(any(unix, target_os = \"wasi\"))/; ${l}s/cfg\(all\(unix, /cfg(all(any(unix, target_os = \"wasi\"), /; ${l}s/cfg\(not\(unix\)\)/cfg(not(any(unix, target_os = \"wasi\")))/; ${l}s/cfg!\(unix\)/cfg!(any(unix, target_os = \"wasi\"))/" "$f"
done
