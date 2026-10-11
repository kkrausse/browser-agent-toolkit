#!/bin/sh
# Refreshes the ghostty-web snapshot in this directory from a checkout of the
# repository `random` (git@github.com:kkrausse/random.git), where the package
# is developed:
#
#   packages/terminal/sync.sh <random checkout> [ref]     ref defaults to HEAD
#
#   ghostty-web/                 the whole package as committed at <ref>
#                                (so no node_modules or dist)
#
# Files come out of `git archive`, never from the working tree, so the
# snapshot is exactly the commit. snapshot.lock is rewritten with what was
# taken. Review `git diff` afterwards, then run the checks in README.md.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
[ $# -ge 1 ] || { sed -n '2,13p' "$0" >&2; exit 2; }
repo=$1
commit=$(git -C "$repo" rev-parse --verify "${2:-HEAD}^{commit}")

rm -rf "$here/ghostty-web"
git -C "$repo" archive "$commit" ghostty-web | tar x -C "$here"

{
  echo "# What ghostty-web/ was taken from (packages/terminal/sync.sh rewrites this file)"
  echo "repository=git@github.com:kkrausse/random.git"
  echo "commit=$commit"
  echo "subject=$(git -C "$repo" log -1 --format=%s "$commit")"
  echo "date=$(git -C "$repo" log -1 --format=%cI "$commit")"
  echo "ghostty-web.last-change=$(git -C "$repo" log -1 --format='%H %s' "$commit" -- ghostty-web)"
  echo "ghostty-web.tree=$(git -C "$repo" rev-parse "$commit:ghostty-web")"
} > "$here/snapshot.lock"
cat "$here/snapshot.lock"
