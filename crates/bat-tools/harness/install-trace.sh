#!/bin/sh
# install-trace.sh <app dir>: put esbuild-trace.cjs in front of the tree's esbuild package
# by pointing the package's "main" at it.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
pkg=$(cd "$(cd "$1/node_modules/vite" && pwd -P)/../esbuild" && pwd -P)
[ -f "$pkg/lib/main.real.js" ] && mv "$pkg/lib/main.real.js" "$pkg/lib/main.js"
cp "$here/esbuild-trace.cjs" "$pkg/lib/trace.cjs"
node -e 'const f=process.argv[1]+"/package.json",fs=require("fs"),p=JSON.parse(fs.readFileSync(f));p.main="lib/trace.cjs";fs.writeFileSync(f,JSON.stringify(p,null,2))' "$pkg"
echo "tracing $pkg"
