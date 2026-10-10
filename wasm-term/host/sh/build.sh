#!/bin/sh
# Builds the shell the `proc_*` imports run: the `bat-sh` crate of THIS
# repository (crates/bat-sh, two directories above wasm-term/) as a
# wasm32-unknown-unknown module, into host/sh/dist/bat_sh.wasm (gitignored;
# the dev server serves it as /bat_sh.wasm).
#
#   host/sh/build.sh             build, and check the result against the sha256
#                                recorded in host/sh/bat-sh.lock; fails if it is
#                                not that module
#   host/sh/build.sh --record    build and rewrite bat-sh.lock: run this, and
#                                commit the lock, after crates/bat-sh changed
#
# The source is the working tree of crates/bat-sh, so the shell is whatever
# this checkout has; the lock records which tree that was (the git tree id of
# crates/bat-sh, "+dirty" with uncommitted changes) and what came out, so a
# module that changed without the source changing (a different toolchain) is
# noticed. BAT_SH_DIR names another crates/bat-sh to build instead.
#
# The sha256 is only comparable in a checkout at the same absolute path: cargo
# hashes the path of the bat-sh crate into its symbol names, which decides the
# order of some functions in the module (the same source gave 4 different
# modules at 8 paths, 857,466 or 857,471 bytes, the same functions in another
# order). So the lock also records where it was built, and a build somewhere
# else is reported, not failed.
# Needs cargo with the wasm32-unknown-unknown target; wasm-opt comes from
# vendor/tools/binaryen (fetched on first use, as ports/codex/scripts/ship.sh does).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
crate=$(cd "${BAT_SH_DIR:-$root/../crates/bat-sh}" && pwd)
top=$(cd "$crate/../.." && pwd)
lock="$here/bat-sh.lock"
record=""
case "${1:-}" in
  "") ;;
  --record) record=1 ;;
  *) echo "usage: host/sh/build.sh [--record]" >&2; exit 2 ;;
esac

tree=$(git -C "$crate" rev-parse --verify -q "HEAD:./" 2>/dev/null || echo unknown)
[ -z "$(git -C "$crate" status --porcelain -- . 2>/dev/null)" ] || tree="$tree+dirty"

wasm_opt="$root/vendor/tools/binaryen/bin/wasm-opt"
if [ ! -x "$wasm_opt" ]; then
  mkdir -p "$root/vendor/tools"
  curl -sL https://github.com/WebAssembly/binaryen/releases/download/version_123/binaryen-version_123-x86_64-linux.tar.gz | tar xz -C "$root/vendor/tools"
  mv "$root/vendor/tools/binaryen-version_123" "$root/vendor/tools/binaryen"
fi

mkdir -p "$here/dist"
export CARGO_TARGET_DIR="$root/vendor/bat-sh-target"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-8}"
# The checkout's path is kept out of the module, so the same source gives the same bytes anywhere.
export RUSTFLAGS="-C target-feature=+bulk-memory,+mutable-globals,+sign-ext,+nontrapping-fptoint --remap-path-prefix=$top=bat-rust"
(cd "$crate/wasm" && cargo build --release --locked --target wasm32-unknown-unknown)
"$wasm_opt" -O2 --enable-bulk-memory --enable-mutable-globals --enable-sign-ext --enable-nontrapping-float-to-int \
  "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/bat_sh_wasm.wasm" -o "$here/dist/bat_sh.wasm"

got=$(sha256sum "$here/dist/bat_sh.wasm" | cut -d' ' -f1)
size=$(wc -c < "$here/dist/bat_sh.wasm" | tr -d ' ')
if [ -n "$record" ]; then
  {
    echo "# What host/sh/dist/bat_sh.wasm is: crates/bat-sh of this repository (host/sh/build.sh --record rewrites this file)"
    echo "tree=$tree"
    echo "built-at=$top"
    echo "sha256=$got"
    echo "size=$size"
    echo "rustc=$(rustc --version)"
  } > "$lock"
else
  want=$(sed -n 's/^sha256=//p' "$lock")
  was=$(sed -n 's/^tree=//p' "$lock")
  at=$(sed -n 's/^built-at=//p' "$lock")
  if [ "$got" != "$want" ]; then
    if [ "$tree" = "$was" ] && [ "$top" != "$at" ]; then
      echo "bat_sh.wasm: same source as bat-sh.lock, which was recorded in a checkout at $at; the sha256 is not comparable here (see the top of this script)" >&2
    elif [ "$tree" != "$was" ]; then
      echo "bat_sh.wasm: crates/bat-sh is $tree, bat-sh.lock was recorded for $was: built $got. Run host/sh/build.sh --record and commit the lock." >&2
      exit 1
    else
      echo "bat_sh.wasm: built $got, bat-sh.lock says $want for the same source (toolchain changed? host/sh/build.sh --record)" >&2
      exit 1
    fi
  fi
fi
echo "bat_sh.wasm  $size bytes  sha256 $got  crates/bat-sh $tree"
