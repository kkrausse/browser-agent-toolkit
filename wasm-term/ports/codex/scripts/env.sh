# Source this: build environment for the codex TUI wasm port.
# Everything heavy lives under wasm-term/vendor/ (gitignored).
PORT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
WASM_TERM_DIR="$(cd "$PORT_DIR/../.." && pwd)"
export CODEX_SRC="$WASM_TERM_DIR/vendor/codex"
export CODEX_UPSTREAM_TAG="rust-v0.162.0"
export CODEX_UPSTREAM_COMMIT="c1382380de69521303b416720a52f42d51af6248"
export WASI_SDK_PATH="$WASM_TERM_DIR/vendor/tools/wasi-sdk"
export WASM_TARGET="${WASM_TARGET:-wasm32-wasip1}"
export CARGO_TARGET_DIR="$WASM_TERM_DIR/vendor/codex-target"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-6}"
# Upstream pins rust 1.95.0 in rust-toolchain.toml; the wasm targets are only
# installed for the default stable toolchain on this box.
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-stable}"
# tokio refuses fs/io-std/net/process/signal/rt-multi-thread on wasm without this.
export RUSTFLAGS="--cfg tokio_unstable ${EXTRA_RUSTFLAGS:-}"
# C dependencies (cc crate) for the wasm target come from wasi-sdk.
for t in wasm32_wasip1 wasm32_wasip1_threads; do
  export "CC_$t=$WASI_SDK_PATH/bin/clang" "CXX_$t=$WASI_SDK_PATH/bin/clang++" "AR_$t=$WASI_SDK_PATH/bin/llvm-ar"
  export "CFLAGS_$t=--sysroot=$WASI_SDK_PATH/share/wasi-sysroot" "CXXFLAGS_$t=--sysroot=$WASI_SDK_PATH/share/wasi-sysroot"
done
# Some build scripts pass -pthread whatever the target (aws-lc-sys does). With it clang keeps
# thread-locals as TLS relocations against __tls_base, and wasi-libc's `errno` is one; the libc
# Rust links for wasm32-wasip1 defines it as a plain global, so the linked code read
# `__tls_base + <absolute address of errno>`: out of bounds, in aws-lc's ERR_put_error, on the
# first TLS handshake. The driver refuses -mno-atomics next to -pthread, so the feature is
# turned off at the cc1 level; without atomics LLVM lowers thread-locals to plain globals,
# as it does for every C file built without -pthread. (The cc crate puts these after its own flags.)
for t in wasm32_wasip1; do
  export "CFLAGS_$t=$(eval echo \$CFLAGS_$t) -Xclang -target-feature -Xclang -atomics"
  export "CXXFLAGS_$t=$(eval echo \$CXXFLAGS_$t) -Xclang -target-feature -Xclang -atomics"
done
# The cc crate passes --target=wasm32-wasi for the threads target, which has no
# headers in wasi-sdk 34's sysroot; name the real triple (the later flag wins).
export CFLAGS_wasm32_wasip1_threads="$CFLAGS_wasm32_wasip1_threads --target=wasm32-wasip1-threads -pthread"
export CXXFLAGS_wasm32_wasip1_threads="$CXXFLAGS_wasm32_wasip1_threads --target=wasm32-wasip1-threads -pthread"
