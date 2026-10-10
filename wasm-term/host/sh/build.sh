#!/bin/sh
# Builds the shell the `proc_*` imports run: bat-rust's `bat-sh` crate as a
# wasm32-unknown-unknown module, from ONE pinned commit of bat-rust, into
# host/sh/dist/bat_sh.wasm (gitignored; the dev server serves it as /bat_sh.wasm).
#
#   host/sh/build.sh             build the commit recorded in host/sh/bat-sh.lock;
#                                fails if the result is not the recorded sha256
#   host/sh/build.sh <commit>    build that commit (any ref of the bat-rust repo)
#                                and rewrite bat-sh.lock: this is how the pin moves
#
# The source is taken with `git archive`, never from a working tree, so what is
# built is exactly the commit. BAT_RUST_REPO names any checkout or worktree of
# bat-rust that has the commit (default: the `codex-shell` worktree).
# Needs cargo with the wasm32-unknown-unknown target; wasm-opt comes from
# vendor/tools/binaryen (fetched on first use, as ports/codex/scripts/ship.sh does).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
repo=${BAT_RUST_REPO:-/home/kkrausse/devfs/repos/kkrausse/bat-rust/.claude/worktrees/codex-shell}
lock="$here/bat-sh.lock"
want=""
if [ $# -ge 1 ]; then
  commit=$(git -C "$repo" rev-parse --verify "$1^{commit}")
else
  commit=$(sed -n 's/^commit=//p' "$lock")
  want=$(sed -n 's/^sha256=//p' "$lock")
fi

src="$root/vendor/bat-sh-src"
rm -rf "$src"
mkdir -p "$src" "$here/dist"
git -C "$repo" archive "$commit" crates/bat-sh | tar x -C "$src"

wasm_opt="$root/vendor/tools/binaryen/bin/wasm-opt"
if [ ! -x "$wasm_opt" ]; then
  mkdir -p "$root/vendor/tools"
  curl -sL https://github.com/WebAssembly/binaryen/releases/download/version_123/binaryen-version_123-x86_64-linux.tar.gz | tar xz -C "$root/vendor/tools"
  mv "$root/vendor/tools/binaryen-version_123" "$root/vendor/tools/binaryen"
fi

export CARGO_TARGET_DIR="$root/vendor/bat-sh-target"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-8}"
export RUSTFLAGS="-C target-feature=+bulk-memory,+mutable-globals,+sign-ext,+nontrapping-fptoint --remap-path-prefix=$src=bat-rust"
(cd "$src/crates/bat-sh/wasm" && cargo build --release --locked --target wasm32-unknown-unknown)
"$wasm_opt" -O2 --enable-bulk-memory --enable-mutable-globals --enable-sign-ext --enable-nontrapping-float-to-int \
  "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/bat_sh_wasm.wasm" -o "$here/dist/bat_sh.wasm"

got=$(sha256sum "$here/dist/bat_sh.wasm" | cut -d' ' -f1)
size=$(wc -c < "$here/dist/bat_sh.wasm" | tr -d ' ')
if [ -n "$want" ]; then
  [ "$got" = "$want" ] || { echo "bat_sh.wasm: built $got, bat-sh.lock says $want (toolchain changed? rerun with the commit to re-pin)" >&2; exit 1; }
else
  {
    echo "# bat-rust commit host/sh/dist/bat_sh.wasm is built from (host/sh/build.sh <commit> rewrites this file)"
    echo "commit=$commit"
    echo "subject=$(git -C "$repo" log -1 --format=%s "$commit")"
    echo "sha256=$got"
    echo "size=$size"
    echo "rustc=$(rustc --version)"
  } > "$lock"
fi
echo "bat_sh.wasm  $size bytes  sha256 $got  bat-rust $commit"
