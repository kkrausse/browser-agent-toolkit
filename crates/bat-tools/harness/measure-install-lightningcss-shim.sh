#!/bin/sh
# measure-install-lightningcss-shim.sh <app dir>
# In a scratch copy of the old-substitution tree (where `lightningcss` resolves to
# lightningcss-wasm), install packages/guest-shims/lightningcss as the package every
# `lightningcss` link points at, with lightningcss-wasm as its sibling dependency
# (Bun isolated layout).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
shim=$(cd "$here/../../../packages/guest-shims/lightningcss" && pwd)
bun=$(cd "$1/node_modules/.bun" && pwd)
slot="$bun/lightningcss@1.32.0-bat/node_modules"
rm -rf "$bun/lightningcss@1.32.0-bat"
mkdir -p "$slot"
cp -R "$shim" "$slot/lightningcss"
ln -s ../../lightningcss-wasm@1.32.0/node_modules/lightningcss-wasm "$slot/lightningcss-wasm"
find "$bun" -maxdepth 4 -type l -name lightningcss | while read -r link; do
  dir=$(dirname "$link")
  target=$(python3 -c 'import os,sys;print(os.path.relpath(sys.argv[1],sys.argv[2]))' "$slot/lightningcss" "$dir")
  rm "$link" && ln -s "$target" "$link"
  echo "relinked ${link#"$bun/"} -> $target"
done
