#!/bin/sh
# Run every guest in runtime/harness/guests and print its exit code and time.
#   runtime/harness/check.sh           (page is reloaded first)
# Expected: every line "0", except cjs.cjs which sets exit code 7 on purpose.
cd "$(dirname "$0")/.."
bun harness/cli.ts reload >/dev/null || exit 2
for g in cjs.cjs esm.mjs ts-main.ts spawn.cjs semantics.cjs watch.cjs als.mjs typescript.cjs babel.cjs react-ssr.mjs vite-config.mjs; do
  line=$(bun harness/cli.ts run --timeout 60000 "harness/guests/$g" 2>&1 >/dev/null | grep '^\[harness\] exit' | tail -1)
  printf '%-18s %s\n' "$g" "$line"
done
