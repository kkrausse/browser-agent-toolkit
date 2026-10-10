#!/bin/sh
# Refreshes the snapshot in this directory from a checkout of the repository
# `random` (git@github.com:kkrausse/random.git), where the two packages are
# developed:
#
#   third_party/sync.sh <random checkout> [ref]     ref defaults to HEAD
#
#   ghostty-web/                 the whole package as committed at <ref>
#                                (so no node_modules or dist)
#   bun-web-terminal/src/        touch.ts, viewport.ts, scroll.ts only
#
# Files come out of `git archive`, never from the working tree, so the
# snapshot is exactly the commit. snapshot.lock is rewritten with what was
# taken. Review `git diff` afterwards, run `cd ../web && bun install` (bun
# copies a file: dependency into node_modules, so the installed copy is stale
# until then), then the checks in ../README.md.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
[ $# -ge 1 ] || { sed -n '2,16p' "$0" >&2; exit 2; }
repo=$1
commit=$(git -C "$repo" rev-parse --verify "${2:-HEAD}^{commit}")
files="bun-web-terminal/src/touch.ts bun-web-terminal/src/viewport.ts bun-web-terminal/src/scroll.ts"

rm -rf "$here/ghostty-web" "$here/bun-web-terminal/src"
# shellcheck disable=SC2086
git -C "$repo" archive "$commit" ghostty-web $files | tar x -C "$here"

{
  echo "# What third_party/ was taken from (third_party/sync.sh rewrites this file)"
  echo "repository=git@github.com:kkrausse/random.git"
  echo "commit=$commit"
  echo "subject=$(git -C "$repo" log -1 --format=%s "$commit")"
  echo "date=$(git -C "$repo" log -1 --format=%cI "$commit")"
  echo "ghostty-web.last-change=$(git -C "$repo" log -1 --format='%H %s' "$commit" -- ghostty-web)"
  echo "ghostty-web.tree=$(git -C "$repo" rev-parse "$commit:ghostty-web")"
  for f in $files; do
    echo "$f=$(git -C "$repo" rev-parse "$commit:$f")"
  done
} > "$here/snapshot.lock"
cat "$here/snapshot.lock"
