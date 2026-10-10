#!/bin/bash
# What a coding agent's shell tool (OpenAI codex: `bash -lc '<command>'`) asks of
# a shell, run under the machine's bash and under bat-sh (native build), one
# line of verdict per case:
#
#   same     stdout and exit status equal bash's
#   differs  both ran, output or status differ (the first difference is shown)
#   missing  bat-sh said "command not found" (127)
#   no-ref   the machine has no such program either; bat-sh's own result is shown
#
#   crates/bat-sh/tests/codex-coverage.sh <path to bat-sh> [filter-regex]
#
# bat-sh runs with an empty PATH so nothing falls through to the machine's
# programs: what passes is in the shell itself.
here=$(cd "$(dirname "$0")" && pwd)
bin=$(realpath "${1:?path to the native bat-sh}")
filter=${2:-.}
work=${TMPDIR:-/tmp}/bat-sh-codex-cov.$$
trap 'rm -rf "$work"' EXIT

setup() {
  rm -rf "$1"; mkdir -p "$1/src/util" "$1/docs" "$1/empty"
  cd "$1" || exit 1
  printf 'fn main() {\n    println!("hello");\n    let total = add(1, 2);\n}\n\nfn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n' > src/main.rs
  printf 'pub fn helper() -> u32 {\n    42 // TODO: real value\n}\n' > src/util/helper.rs
  printf '# Demo\n\nA small project.\n\n## Usage\n\nrun it\n' > README.md
  printf '[package]\nname = "demo"\nversion = "0.1.0"\n' > Cargo.toml
  printf '{"name":"demo","version":"1.0.0","scripts":{"test":"echo ok"}}\n' > package.json
  printf 'banana\napple\ncherry\napple\n10\n9\n' > list.txt
  printf 'alice 30 nyc\nbob 25 sf\ncarol 35 nyc\n' > people.txt
  printf 'line1\nline2\nline3\n' > a.txt
  printf 'line1\nline2 changed\nline3\nline4\n' > b.txt
  printf 'notes\n' > docs/notes.md
}

n_same=0; n_diff=0; n_missing=0; n_noref=0
run_case() {
  local group=$1 label=$2 cmd=$3
  echo "$group/$label" | grep -Eq "$filter" || return
  setup "$work/w"; local exp; exp=$(cd "$work/w" && TZ=UTC HOME=$work/w bash -c "$cmd" </dev/null 2>"$work/ref.err"; echo "status=$?")
  setup "$work/w"; local got; got=$(cd "$work/w" && TZ=UTC HOME=$work/w PATH=/nonexistent /usr/bin/timeout 10 "$bin" -c "$cmd" </dev/null 2>"$work/got.err"; echo "status=$?")
  local verdict detail=""
  if grep -q 'command not found' "$work/got.err" && echo "$got" | grep -q 'status=127$'; then
    verdict=missing; n_missing=$((n_missing+1)); detail=$(head -1 "$work/got.err")
  elif grep -q 'command not found' "$work/ref.err"; then
    verdict=no-ref; n_noref=$((n_noref+1)); detail=$(echo "$got" | tr '\n' '|' | cut -c1-100)
  elif [ "$exp" == "$got" ]; then
    verdict=same; n_same=$((n_same+1))
  else
    verdict=differs; n_diff=$((n_diff+1))
    detail="bash: $(echo "$exp" | tr '\n' '|' | cut -c1-110)  bat-sh: $(echo "$got" | tr '\n' '|' | cut -c1-110) $(head -c 120 "$work/got.err" | tr '\n' ' ')"
  fi
  printf '%-8s %-10s %-24s %s\n' "$verdict" "$group" "$label" "$cmd"
  [ -n "$detail" ] && [ "$verdict" != same ] && printf '         %s\n' "$detail"
}

while IFS=$'\t' read -r group label cmd; do
  case "$group" in ''|'#'*) continue;; esac
  run_case "$group" "$label" "${cmd//¶/$'\n'}"
done < "$here/codex-cases.tsv"
echo "same=$n_same differs=$n_diff missing=$n_missing no-ref=$n_noref"
