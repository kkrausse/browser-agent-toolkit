#!/usr/bin/env bash
# Create vendor/forks/<name> from the crates.io source of <name>-<version> as a
# git repo (branch `upstream` = pristine, `wasm-term-port` = ours).
# usage: scripts/fork-crate.sh <name> <version>
set -euo pipefail
source "$(dirname "$0")/env.sh"
name="$1"; version="$2"
dest="$WASM_TERM_DIR/vendor/forks/$name"
[ -d "$dest" ] && { echo "exists: $dest"; exit 0; }
src=$(ls -d "$HOME"/.cargo/registry/src/index.crates.io-*/"$name-$version" | head -1)
mkdir -p "$(dirname "$dest")"
cp -r "$src" "$dest"
cd "$dest"
rm -f .cargo-ok Cargo.toml.orig
git init -q
git add -A -f
git -c user.name=port -c user.email=port@local commit -qm "$name $version (crates.io)"
git branch -m upstream
git checkout -q -b wasm-term-port
grep -qx "$name $version" "$PORT_DIR/scripts/forks.txt" || echo "$name $version" >> "$PORT_DIR/scripts/forks.txt"
echo "forked $name $version -> $dest"
