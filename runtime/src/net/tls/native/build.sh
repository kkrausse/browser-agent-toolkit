#!/bin/sh
# Build runtime/src/net/tls/bat_tls.wasm (rustls + ring, wasm32-wasip1) from this crate.
#
# The Wasm file is committed, so `bun run setup` needs none of this. To rebuild it:
#
#   WASI_SDK=/path/to/wasi-sdk sh runtime/src/net/tls/native/build.sh
#
# ring has C sources, which need a clang that targets wasm32-wasip1 (wasi-sdk's); Cargo.lock
# pins every crate, including the root list (webpki-roots). The committed file was built with
# wasi-sdk's clang 23.1.0 and Rust 1.99.0 (647,499 bytes).
#
# To move the root list or rustls forward: `cargo update` in this directory, rebuild, commit
# Cargo.lock and the Wasm file together.
#
# A build for tests, which also trusts one certificate of your own (never the committed file):
#
#   BAT_TLS_TEST_ROOT=/path/to/ca.der OUT=/tmp/bat_tls_test.wasm WASI_SDK=… sh build.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../../.." && pwd)
: "${WASI_SDK:?set WASI_SDK to a wasi-sdk directory (its bin/clang compiles ring's C sources)}"
out=${OUT:-$here/../bat_tls.wasm}
features=
if [ -n "${BAT_TLS_TEST_ROOT:-}" ]; then
  [ -n "${OUT:-}" ] || { echo "a test build needs OUT: it must not replace the committed file" >&2; exit 2; }
  features="--features test-root"
  export BAT_TLS_TEST_ROOT
fi
export CC_wasm32_wasip1="$WASI_SDK/bin/clang"
export AR_wasm32_wasip1="$WASI_SDK/bin/llvm-ar"
export CFLAGS_wasm32_wasip1="--sysroot=$WASI_SDK/share/wasi-sysroot"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$root/target/bat-tls}"
# shellcheck disable=SC2086
cargo build --manifest-path "$here/Cargo.toml" --release --locked --target wasm32-wasip1 $features
cp "$CARGO_TARGET_DIR/wasm32-wasip1/release/bat_tls.wasm" "$out"
ls -l "$out"
