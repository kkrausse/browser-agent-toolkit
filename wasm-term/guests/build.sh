#!/usr/bin/env bash
# Builds every guest for wasm32-wasip1 and copies the modules to guests/dist/,
# which is where the dev server looks for /guests/<name>.wasm.
set -euo pipefail
cd "$(dirname "$0")"

# The ratatui guests need the crossterm fork with the wasi backend.
[ -d crossterm-wasi ] && [ ! -d crossterm-wasi/crossterm ] && ./crossterm-wasi/setup.sh

cargo build --release "$@"
mkdir -p dist
cp target/wasm32-wasip1/release/*.wasm dist/
ls -l dist/*.wasm
