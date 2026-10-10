#!/bin/bash
# Run each case under the machine's bash and under bat-sh (native build) in a
# scratch directory and report differences in stdout, stderr-emptiness and status.
#   crates/bat-sh/tests/compare.sh [path to bat-sh]
here=$(cd "$(dirname "$0")" && pwd)
bin=${1:-$here/../../../target-gaps/debug/bat-sh}
ref=${REF_SHELL:-bash}
pass=0; fail=0
setup() {
  rm -rf "$1"; mkdir -p "$1/src/sub" "$1/empty"
  cd "$1" || exit 1
  printf 'export const a = 1\n' > src/a.tsx
  printf 'export const b = 2\nconsole.log("b")\n' > src/b.tsx
  printf 'x\n' > src/sub/c.ts
  printf '{\n  "name": "demo",\n  "version": "1.0.0",\n  "scripts": { "hello": "echo hello $npm_lifecycle_event" }\n}\n' > package.json
  printf 'banana\napple\ncherry\napple\n10\n9\n' > list.txt
  printf 'one two three\nfour five six\n' > words.txt
}
while IFS= read -r -d $'\x01' case_; do
  case_=${case_#$'\n'}
  [ -z "$case_" ] && continue
  setup /tmp/bat-sh-cmp/work; exp=$(cd /tmp/bat-sh-cmp/work && TZ=UTC $ref -c "$case_" 2>/tmp/bat-sh-cmp/ref.err; echo "status=$?")
  setup /tmp/bat-sh-cmp/work; got=$(cd /tmp/bat-sh-cmp/work && TZ=UTC "$bin" -c "$case_" 2>/tmp/bat-sh-cmp/got.err; echo "status=$?")
  e1=$([ -s /tmp/bat-sh-cmp/ref.err ] && echo y || echo n); e2=$([ -s /tmp/bat-sh-cmp/got.err ] && echo y || echo n)
  if [ "$exp" == "$got" ] && [ "$e1" == "$e2" ]; then pass=$((pass+1)); else
    fail=$((fail+1)); printf -- '--- FAIL: %s\n  expected: %s (stderr %s)\n  got:      %s (stderr %s: %s)\n' "$case_" "$exp" "$e1" "$got" "$e2" "$(head -c 300 /tmp/bat-sh-cmp/got.err)"
  fi
done < "$here/cases.txt"
echo "pass=$pass fail=$fail"
[ "$fail" = 0 ]
