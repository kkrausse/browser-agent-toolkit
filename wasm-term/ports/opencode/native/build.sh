#!/bin/sh
# Builds OpenTUI's native core (Zig + Yoga C++ + image C libs) as a WASI
# reactor module: dist/opentui.wasm.
#   usage: native/build.sh [ReleaseFast|ReleaseSmall|Debug]
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/../../.." && pwd)
OPENTUI="$ROOT/vendor/opentui"
NATIVE="$OPENTUI/packages/native"
ZIG_DIR="$ROOT/vendor/tools/zig-x86_64-linux-0.16.0"
OPTIMIZE=${1:-ReleaseFast}

[ -x "$ZIG_DIR/zig" ] || { echo "zig 0.16.0 missing: see NOTES.md (Toolchain)" >&2; exit 1; }
[ -d "$NATIVE" ] || { echo "vendor/opentui missing: see NOTES.md (Checkouts)" >&2; exit 1; }

# Idempotent: apply the source patch only if it is not already applied.
if git -C "$OPENTUI" apply --reverse --check "$HERE/opentui-native-wasm.patch" 2>/dev/null; then
  :
else
  git -C "$OPENTUI" apply "$HERE/opentui-native-wasm.patch"
fi

sh "$NATIVE/scripts/prepare-zig-deps.sh"
bun "$HERE/gen-lib-wasm.ts" "$NATIVE/src/lib.zig" "$NATIVE/src/lib-wasm.zig"

export ZIG_GLOBAL_CACHE_DIR="$ROOT/vendor/tools/zig-cache"
(cd "$NATIVE" && "$ZIG_DIR/zig" build -Dlibrary-target=wasm32-wasi "-Doptimize=$OPTIMIZE")

mkdir -p "$HERE/../dist"
bun "$HERE/postprocess.ts" "$NATIVE/lib/wasm32-wasi/opentui.wasm" "$HERE/../dist/opentui.wasm"
ls -l "$HERE/../dist/opentui.wasm"
