#!/bin/sh
# usage: run.sh [image]
cd /tmp/bat-resolve-ws/crates/bat-kernel
BAT_RESOLVE_IMAGE=${1:-/tmp/bat-resolve-cases/real.batimg} BAT_RESOLVE_CASES=${CASES:-/tmp/bat-resolve-cases/cases.tsv} BAT_RESOLVE_OVERLAY=/tmp/bat-resolve-cases/overlay.tsv CARGO_TARGET_DIR=/home/kkrausse/devfs/repos/kkrausse/bat-rust/target-runtime cargo test -p bat-kernel --release --lib resolve::tests::real_tree -- --ignored --nocapture > /tmp/bat-resolve-cases/run.log 2>&1
grep -c MISMATCH /tmp/bat-resolve-cases/run.log
grep -v "^   \|MISMATCH" /tmp/bat-resolve-cases/run.log | grep -v "^$" | tail -12
