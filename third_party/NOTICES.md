# Third-party code in this tree

## Node.js (`third_party/node/`)

The files under `third_party/node/lib/` and `third_party/node/internal/` whose header says
"VENDORED VERBATIM from Node.js v24.18.0" are Node.js's own `lib/` sources
(https://github.com/nodejs/node, tag v24.18.0), unmodified except for being wrapped in a
factory function `(exports, require, module, process, internalBinding, primordials)`.

    Copyright Node.js contributors. All rights reserved.
    Copyright Joyent, Inc. and other Node contributors.

    Permission is hereby granted, free of charge, to any person obtaining a copy of this
    software and associated documentation files (the "Software"), to deal in the Software
    without restriction, including without limitation the rights to use, copy, modify, merge,
    publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
    to whom the Software is furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all copies or
    substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
    INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
    PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
    FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
    OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
    DEALINGS IN THE SOFTWARE.

`lib/string_decoder.js` is adapted from the `string_decoder` npm package (MIT, Node.js
contributors), `lib/punycode.js` is Node's bundled punycode.js (MIT, Mathias Bynens).

## Vivari (`third_party/node/`, everything not marked verbatim)

The remaining files (`primordials.js`, `bindings/*.js`, and the `internal/*` and `lib/*`
files without the "VENDORED VERBATIM" header: shims and bridges that let Node's lib run
without its C++ core) are copied from Vivari's runtime
(`packages/runtime/node/`), MIT, Copyright (c) 2026 Duc Trung Mai and Vivari contributors.
The full license text is in `third_party/node/LICENSE.vivari`. One local change:
`primordials.js` uncurries with `Function.prototype.call.bind` instead of a rest-argument
closure.

What was taken is the closure needed by `events`, `stream` (+ `/promises`, `/consumers`),
`buffer`, `util`, `path`, `url`, `querystring`, `string_decoder`, `assert`,
`timers/promises`, `diagnostics_channel` and `punycode`. `fs`, `readline`, `timers`,
`async_hooks` and everything that touches the kernel are written in `runtime/src/node/`.

## regex-lite (linked into `bat_sh.wasm`)

`crates/bat-sh` (the guest's `/bin/sh` and coreutils) depends on `regex-lite` 0.1
(`grep`, `sed`, `[[ =~ ]]`), Copyright (c) The Rust Project Developers, used under the MIT
license (the crate is dual-licensed MIT OR Apache-2.0). It is a build dependency fetched by
Cargo, not vendored. The shell's parser, expansion, interpreter and utilities are written
here; no shell or coreutils crate is used.

## jaq (linked into `bat_sh.wasm`)

The shell's `jq` (`crates/bat-sh/src/jq.rs`) is the jaq interpreter: `jaq-core` 3.1.1,
`jaq-std` 3.0.3, `jaq-json` 2.0.3 and their JSON lexer `hifijson`, Copyright (c) Michael
Färber, MIT. They are build dependencies fetched by Cargo, not vendored. The definitions of
`join`, `IN`, `INDEX`, `tostream` and `truncate_stream` in that file follow jq's own
`builtin.jq` (https://github.com/jqlang/jq, Copyright (C) 2012 Stephen Dolan, MIT).

jaq brings these crates into `bat_sh.wasm` with it: `jiff`, `jiff-core`, `jiff-tzdb`,
`jiff-tzdb-platform` (dates; the bundled time zone data is the IANA database, public domain),
`aho-corasick`, `memchr` (Unlicense OR MIT); `regex-bites`, `regex-automata`, `bstr`,
`base64`, `num-bigint`, `num-integer`, `num-traits`, `indexmap`, `hashbrown`, `equivalent`,
`dyn-clone`, `once_cell`, `log` (MIT OR Apache-2.0); `bytes`, `libm`, `typed-arena`,
`urlencoding` (MIT); `foldhash` (Zlib); `ryu` (Apache-2.0 OR BSL-1.0); `self_cell`
(Apache-2.0 OR GPL-2.0-only, used under Apache-2.0).

## SQLite and wasi-libc (`runtime/src/sqlite/sqlite3.wasm`, a committed binary)

Built by `runtime/src/sqlite/native/build.sh` (inputs, checksums and download URLs are in
its header; `--fetch` reproduces the toolchain) from:

- the SQLite 3.53.1 amalgamation (https://www.sqlite.org), which is in the public domain;
- `runtime/src/sqlite/native/bat_sqlite.c`, written here;
- the parts of wasi-libc that clang links in from wasi-sdk 34 (`malloc`, string and math
  functions; no file or clock functions). wasi-libc
  (https://github.com/WebAssembly/wasi-libc) is licensed under Apache-2.0 WITH
  LLVM-exception, Apache-2.0 and MIT; it contains musl (MIT, Copyright © 2005-2020 Rich
  Felker, et al.) and dlmalloc (Doug Lea, CC0), and the compiler runtime it is linked with
  is LLVM's compiler-rt (Apache-2.0 WITH LLVM-exception).

The binary was post-processed with Binaryen's `wasm-opt` (a tool; nothing of it is linked).

## Tailwind CSS oxide scanner (`crates/bat-tools/oxide/vendor/tailwindcss-oxide/`)

`crates/oxide/src` of tailwindlabs/tailwindcss at tag v4.3.3, MIT, Copyright (c) Tailwind
Labs, Inc.; the full text is in that directory's `LICENSE` and beside the built package
(`packages/guest-shims/tailwindcss-oxide/LICENSE`). One source change, marked
`CHANGED (bat)`; the directory's `Cargo.toml` says what and why. The committed binary
`packages/guest-shims/tailwindcss-oxide/tailwindcss-oxide.wasm` is built from it by
`crates/bat-tools/oxide/build-wasm.sh` and links the scanner's crates.io dependencies
(58 packages in `crates/bat-tools/oxide/Cargo.lock`: `ignore`, `walkdir`, `globwalk`,
`bstr`, `regex`, `rayon`, `dunce` and what they need; each MIT, Apache-2.0, or Unlicense/MIT).
`same-file` is replaced by a stub written here (`crates/bat-tools/oxide/stubs/same-file`).

## oxc (linked into `bat-prepare`, `bat_modules.wasm` and the committed `bat_esbuild.wasm`)

`crates/bat-modules` and `crates/bat-tools` use the oxc 0.153 crates (parser, semantic,
transformer, codegen and their dependencies; https://github.com/oxc-project/oxc), MIT,
Copyright (c) 2024-present VoidZero Inc. & Contributors. Cargo dependencies, not vendored.
`packages/guest-shims/esbuild/lib/bat_esbuild.wasm` is a committed binary built by
`crates/bat-tools/build-wasm.sh`; `bat_modules.wasm` is built by `bun run setup`. `js-sys`
is replaced by a stub written here in both Wasm builds.

## lightningcss (`packages/guest-shims/lightningcss/bat-vendor/`)

Three pure-JavaScript files of lightningcss 1.32.0, unmodified except for the `.cjs`
extension, MPL-2.0; the license text is in that directory. `lightningcss-wasm`, which the
shim loads lazily, is an ordinary npm dependency of the prepared guest tree.

## Vite (`packages/guest-shims/prepare/vite-optimize-runner.mjs`)

Contains a copy of two functions of Vite 7 (`getConfigHash`, `getLockfileHash`;
https://github.com/vitejs/vite), MIT, Copyright (c) 2019-present, VoidZero Inc. and Vite
contributors. Used only on the build host, when the optimizer cannot run under bubblewrap.

## Other Rust crates linked into shipped Wasm or the prepare tool

Cargo dependencies, none vendored; exact versions are in `Cargo.lock` and the `Cargo.lock`
of each `wasm/` workspace.

| Where | Crates | License |
| --- | --- | --- |
| `kernel.wasm` | `httparse` (HTTP/1.1 head parser), `dlmalloc` (allocator) | MIT OR Apache-2.0 |
| `bat_node_native.wasm` (`zlib`, `crypto`) | `flate2` with `miniz_oxide`, `crc32fast`, `adler2` | MIT OR Apache-2.0 (miniz_oxide also Zlib; adler2 also 0BSD) |
| | `brotli`, `alloc-no-stdlib`, `brotli-decompressor` | BSD-3-Clause OR MIT |
| | RustCrypto: `digest`, `md-5`, `sha1`, `sha2`, `hmac`, `pbkdf2`, `scrypt`, `salsa20`, `aes`, `ghash` and their support crates | MIT OR Apache-2.0 |
| `bat_sh.wasm` | `regex-lite` (above); jaq and what it brings (above) | MIT OR Apache-2.0; as stated above |
| `bat_tls.wasm` (`runtime/src/net/tls/`, committed; its own `Cargo.lock` in `native/`) | `rustls` 0.23.45 (TLS) | Apache-2.0 OR ISC OR MIT |
| | `ring` 0.17.14 (cryptography; includes code from BoringSSL and OpenSSL, see its `LICENSE` files) | Apache-2.0 AND ISC |
| | `rustls-webpki` 0.103.15 (certificate verification), `untrusted` | ISC |
| | `webpki-roots` 1.0.9: the trust anchors, Mozilla's root certificate list as data | CDLA-Permissive-2.0 |
| | `subtle` | BSD-3-Clause |
| | `rustls-pki-types`, `zeroize`, `once_cell`, `getrandom`, `cfg-if`, `wasi` | MIT OR Apache-2.0 |
| `bat-prepare` (native tool, never sent to a browser) | `zstd` / `zstd-safe` / `zstd-sys`, which compile the reference libzstd (Meta Platforms, BSD-3-Clause; the crates MIT OR Apache-2.0); `sha2`, `rayon`, `clap`, `serde`, `serde_json`, `anyhow` | as stated; the rest MIT OR Apache-2.0 |

The zstd copy of an image that `bat-prepare` writes is decoded by the browser's network
stack (`Content-Encoding: zstd`); no decoder is shipped.

## ghostty-web (`packages/terminal/ghostty-web/`)

A snapshot of the package `ghostty-web` of the repository `random` (same author), MIT,
Copyright (c) 2025 Coder, Copyright (c) 2026 kkrausse (`ghostty-web/LICENSE`); its
`vendor/ghostty-vt.wasm` and `vendor/headers/` are the unmodified upstream Ghostty release
artifact and C headers, MIT, Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors
(`ghostty-web/vendor/LICENSE`). Source commit and how to refresh: `packages/terminal/README.md`.

## Not in this tree, fetched at setup or install time

- **OpenCode 2.0.26 and OpenTUI 0.5.17 sources** (`ports/opencode/vendor/`, gitignored):
  cloned from `anomalyco/opencode` (tag `v2.0.26`) and `anomalyco/opentui` (tag `v0.5.17`),
  both MIT, by `ports/opencode/setup-vendor.sh`, and bundled into the terminal client
  (`ports/opencode/dist/node/`, in a prepared image at `/app/tui/`) with their npm
  dependencies under their own licenses. `ports/opencode/native/opentui-native-wasm.patch`
  is a patch to OpenTUI's sources; the edits in `ports/opencode/build/*-plugin.ts` quote
  the lines of OpenTUI and OpenCode they replace. The 2.0.26 server
  (`ports/opencode/server`) is bundled from the published `@opencode/server` packages.

- **OpenCode 2.0.3 server** (`server.js` and three tree-sitter `.wasm` files): downloaded by
  `scripts/setup.ts` from a checksummed release asset into the gitignored `.runtime/`, and
  copied into the prepared output. OpenCode is MIT (https://github.com/anomalyco/opencode);
  the bundle contains its dependencies under their own licenses. What the toolkit package
  itself took from OpenCode, shadcn/ui and Marked is listed in `packages/toolkit/NOTICES.md`.
- **npm packages of the guest tree** (Vite, React Router, Tailwind, `esbuild-wasm`,
  `@rollup/wasm-node`, `lightningcss-wasm`, `ripgrep`, …) are installed by Bun from the
  registry and packed into the dependency image unmodified, each with the license file its
  package ships. A site that serves a prepared image distributes those packages.
