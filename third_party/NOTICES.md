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
