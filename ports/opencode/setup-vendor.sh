#!/bin/sh
# Fetches what the client build needs into the gitignored vendor/ beside this script:
#
#   vendor/opencode                       anomalyco/opencode at v2.0.26, with its npm dependencies (about 3.2 GB)
#   vendor/opentui                        anomalyco/opentui at v0.5.17 (the version that opencode pins), with its dependencies
#   vendor/tools/zig-x86_64-linux-0.16.0  the Zig toolchain that builds OpenTUI's core (build:native)
#
#   ports/opencode/setup-vendor.sh
#
# Each step is skipped when its directory (or a symlink to one) is already there, so a
# vendor/ that links to checkouts kept elsewhere is left as it is. Needs git, curl, tar with
# xz, bun and network access. Linux x86_64 only as written (the Zig archive).
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
vendor="$here/vendor"
mkdir -p "$vendor/tools"

checkout() { # <name> <tag>
  if [ -e "$vendor/$1" ]; then echo "vendor/$1: present, left alone"; return; fi
  git clone --depth 1 --branch "$2" "https://github.com/anomalyco/$1.git" "$vendor/$1"
  (cd "$vendor/$1" && bun install --ignore-scripts)
}
checkout opentui v0.5.17
checkout opencode v2.0.26

zig=zig-x86_64-linux-0.16.0
if [ -e "$vendor/tools/$zig" ]; then echo "vendor/tools/$zig: present, left alone"
else curl -fsSL "https://ziglang.org/download/0.16.0/$zig.tar.xz" | tar -xJ -C "$vendor/tools"
fi
echo "done: bun run build:native && bun run build:tui:node (in $here)"
