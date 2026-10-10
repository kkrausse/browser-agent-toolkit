#!/bin/sh
# Build runtime/src/sqlite/sqlite3.wasm from the SQLite amalgamation and bat_sqlite.c.
#
# The Wasm file is committed (656 KiB), so `bun run setup` needs none of this. To rebuild it:
#
#   sh runtime/src/sqlite/native/build.sh --fetch
#
# downloads the three pinned inputs below into $BAT_SQLITE_TOOLCHAIN (default
# <repo>/target/sqlite-toolchain, gitignored; about 300 MB of downloads, 1 GB unpacked),
# checks each against its sha256, unpacks them and builds with wasm-opt. An archive that is
# already there with the right sum is not downloaded again. Linux x86-64 only as written;
# on another host take the matching wasi-sdk and binaryen archives and use the explicit form:
#
#   WASI_SDK=/path/to/wasi-sdk-34.0-x86_64-linux \
#   SQLITE_SRC=/path/to/sqlite-amalgamation-3530100 \
#   [WASM_OPT=/path/to/binaryen/bin/wasm-opt] [OPT=-Os] [OUT=…] sh build.sh
#
# Inputs used for the committed binary (sha256), which was built with WASM_OPT set:
#   https://www.sqlite.org/2026/sqlite-amalgamation-3530100.zip
#     36ad6e7f38540a3b21a2ac36340833f0a9e426bc1c752751c3ba669466827eae
#   https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sdk-34.0-x86_64-linux.tar.gz
#     b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4
#   https://github.com/WebAssembly/binaryen/releases/download/version_133/binaryen-version_133-x86_64-linux.tar.gz
#     2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489
#
# The result imports only module "bat" (see bat_sqlite.c); the handful of WASI
# imports wasi-libc would add are not pulled in because SQLITE_OS_OTHER removes
# every use of the C library's file and clock functions. wasi-libc's malloc, string and
# math functions are linked in (notices: third_party/NOTICES.md).
set -eu
here=$(cd "$(dirname "$0")" && pwd)

if [ "${1:-}" = --fetch ]; then
  dir=${BAT_SQLITE_TOOLCHAIN:-$here/../../../../target/sqlite-toolchain}
  mkdir -p "$dir/dl"
  dir=$(cd "$dir" && pwd)
  # name, sha256, url
  fetch() {
    if [ ! -f "$dir/dl/$1" ] || ! echo "$2  $dir/dl/$1" | sha256sum -c --status; then
      echo "downloading $1" >&2
      curl -fL --retry 2 -o "$dir/dl/$1.part" "$3"
      mv "$dir/dl/$1.part" "$dir/dl/$1"
      echo "$2  $dir/dl/$1" | sha256sum -c --status || { echo "$1 does not match its pinned sha256" >&2; exit 1; }
    fi
  }
  fetch sqlite-amalgamation-3530100.zip 36ad6e7f38540a3b21a2ac36340833f0a9e426bc1c752751c3ba669466827eae \
    https://www.sqlite.org/2026/sqlite-amalgamation-3530100.zip
  fetch wasi-sdk-34.0-x86_64-linux.tar.gz b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4 \
    https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sdk-34.0-x86_64-linux.tar.gz
  fetch binaryen-version_133-x86_64-linux.tar.gz 2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489 \
    https://github.com/WebAssembly/binaryen/releases/download/version_133/binaryen-version_133-x86_64-linux.tar.gz
  # Each archive is unpacked into a directory of its own, once.
  [ -d "$dir/src/sqlite-amalgamation-3530100" ] || { mkdir -p "$dir/src" && unzip -q "$dir/dl/sqlite-amalgamation-3530100.zip" -d "$dir/src"; }
  [ -d "$dir/sdk/wasi-sdk-34.0-x86_64-linux" ] || { mkdir -p "$dir/sdk" && tar -xzf "$dir/dl/wasi-sdk-34.0-x86_64-linux.tar.gz" -C "$dir/sdk"; }
  [ -d "$dir/binaryen/binaryen-version_133" ] || { mkdir -p "$dir/binaryen" && tar -xzf "$dir/dl/binaryen-version_133-x86_64-linux.tar.gz" -C "$dir/binaryen"; }
  WASI_SDK=$dir/sdk/wasi-sdk-34.0-x86_64-linux
  SQLITE_SRC=$dir/src/sqlite-amalgamation-3530100
  WASM_OPT=$dir/binaryen/binaryen-version_133/bin/wasm-opt
fi
: "${WASI_SDK:?set WASI_SDK, or run with --fetch}"
: "${SQLITE_SRC:?set SQLITE_SRC, or run with --fetch}"
OPT=${OPT:--Os}
OUT=${OUT:-$here/../sqlite3.wasm}
EXTRA=${EXTRA:-}

exports=$(grep -v '^#' "$here/exports.txt" | grep . | sed 's/^/-Wl,--export=/' | tr '\n' ' ')

# shellcheck disable=SC2086
"$WASI_SDK/bin/clang" --target=wasm32-wasip1 $OPT \
  -mexec-model=reactor \
  -mbulk-memory -msign-ext -mnontrapping-fptoint -mmutable-globals \
  -DNDEBUG \
  -DSQLITE_OS_OTHER=1 \
  -DSQLITE_THREADSAFE=0 \
  -DSQLITE_TEMP_STORE=3 \
  -DSQLITE_DEFAULT_MEMSTATUS=0 \
  -DSQLITE_OMIT_LOAD_EXTENSION \
  -DSQLITE_OMIT_DEPRECATED \
  -DSQLITE_OMIT_SHARED_CACHE \
  -DSQLITE_OMIT_PROGRESS_CALLBACK \
  -DSQLITE_OMIT_UTF16 \
  -DSQLITE_OMIT_GET_TABLE \
  -DSQLITE_OMIT_COMPLETE \
  -DSQLITE_OMIT_TCL_VARIABLE \
  -DSQLITE_DQS=0 \
  -DSQLITE_LIKE_DOESNT_MATCH_BLOBS \
  -DSQLITE_MAX_EXPR_DEPTH=1000 \
  -DSQLITE_USE_ALLOCA \
  -DSQLITE_ENABLE_COLUMN_METADATA \
  -DSQLITE_ENABLE_MATH_FUNCTIONS \
  -DSQLITE_DEFAULT_AUTOVACUUM=0 \
  -DSQLITE_DEFAULT_RECURSIVE_TRIGGERS=1 \
  -DSQLITE_DIRECT_OVERFLOW_READ \
  -DHAVE_MALLOC_H=1 -DHAVE_MALLOC_USABLE_SIZE=1 \
  $EXTRA \
  -I"$SQLITE_SRC" \
  -Wl,--no-entry -Wl,--stack-first -Wl,-z,stack-size=1048576 \
  -Wl,--initial-memory=4194304 -Wl,--max-memory=4294967296 \
  -Wl,--strip-all \
  $exports \
  -o "$OUT.tmp" \
  "$SQLITE_SRC/sqlite3.c" "$here/bat_sqlite.c"

if [ -n "${WASM_OPT:-}" ]; then
  "$WASM_OPT" $OPT --enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int \
    --enable-mutable-globals --strip-debug --strip-producers "$OUT.tmp" -o "$OUT"
  rm "$OUT.tmp"
else
  mv "$OUT.tmp" "$OUT"
fi
ls -l "$OUT"
