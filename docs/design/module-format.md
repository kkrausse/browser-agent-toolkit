# Module format (`bat-modules`)

What the module transform (`crates/bat-modules`) produces and what a loader must do with it.
The transform runs natively at prepare time over every dependency file and, compiled to
Wasm, at load time for workspace files. Its output is always the **body of a function**; the
loader supplies the function header, chosen from the module's facts.

Two artefacts are normative: this document, and `crates/bat-modules/harness/loader.mjs`, a
synchronous loader of about 350 lines that implements it and is exercised against real programs (see
"Verification"). Where the two disagree the loader is right and this file has a bug.
"Reference only" below marks behaviour of that loader a port may change.

## 1. The transform

```rust
bat_modules::transform(source: &str, filename: &str, options: &Options) -> Output
Output { code: Cow<str>, facts: Facts, map: Option<String>, diagnostics: Vec<Diagnostic> }
```

No I/O, no global state; safe to call from any number of threads. `output.ok()` is false when
a diagnostic is an error; then `code` is empty.

### Module kind

1. `.mjs`, `.mts` → ES module. `.cjs`, `.cts` → CommonJS. `.json` → JSON.
2. Otherwise `options.package_type`, the `type` of the nearest `package.json` (the caller
   reads it; the search stops at a `node_modules` directory, as in Node).
3. Otherwise (no `type`) by syntax, as Node does: an ES module if the file has `import`,
   `export` or `import.meta`; or if it only parses as a module (top-level `await`); or if it
   declares `require`, `module`, `exports`, `__filename` or `__dirname` with `let`, `const`
   or `class` at the top level (a syntax error under the CommonJS wrapper). Else CommonJS.

One deliberate difference from Node: a file that is CommonJS by rule 1 or 2 but is written
with `import`/`export` is transformed as an ES module, with a warning. Packages that ship ESM
in `.js` without `"type"` to bundlers, and TypeScript sources in CommonJS packages, depend on
it. `options.force_kind` overrides everything.

### TypeScript and JSX

`.ts .mts .cts .tsx .jsx` are first lowered to JavaScript by oxc's transformer and printed by
its codegen, then go through the same pass as any `.js` file. Only types and JSX are lowered;
no JavaScript syntax is downlevelled. Options (`Options.ts`):

| tsconfig | field | effect |
| --- | --- | --- |
| `jsx: react-jsx` | `JsxMode::Automatic` (default) | `jsx`/`jsxs` from `<jsxImportSource>/jsx-runtime` |
| `jsx: react-jsxdev` | `JsxMode::AutomaticDev` | `jsxDEV` from `<jsxImportSource>/jsx-dev-runtime` |
| `jsx: react` | `JsxMode::Classic` | `jsxFactory` / `jsxFragmentFactory` calls |
| `jsx: preserve` | map to `Automatic` | JSX cannot be executed as is |
| `jsxImportSource` | `jsx_import_source` | default `react` |
| `verbatimModuleSyntax` | `verbatim_module_syntax` | unused value imports are kept |
| `experimentalDecorators`, `emitDecoratorMetadata` | same names | legacy decorators are compiled |
| `useDefineForClassFields: false` | `use_define_for_class_fields` | fields become constructor assignments |

Limits, all from oxc 0.153:

- **Standard (TC39) decorators are not lowered.** They are kept, a warning is reported, and
  current Chrome will refuse the module. Only `experimentalDecorators` compile.
- Legacy decorators, and private fields under `useDefineForClassFields: false`, call helpers
  that are **imported from `@oxc-project/runtime/helpers/<name>`**. They appear in
  `facts.imports` like any dependency; the runtime must make that package resolvable for
  workspace code that uses these options.
- `import x = require("y")` and `export = v` work in files that are CommonJS (`.cts`, or a
  CommonJS package) and are errors in ES modules.

### Lines, columns, source maps

For JavaScript input nothing is re-printed: the output is the source text with byte ranges
replaced. Every line keeps its number. A removed `import`/`export` statement leaves a `;` and
its line breaks; a rewritten identifier shifts the rest of its line. The ES module prelude
(§3) sits in front of line 1, so line 1 alone is shifted right. Stack traces are therefore
correct to the line without a source map, and no map is produced.

TypeScript/JSX output is re-printed, so lines differ. With `options.source_map` the output
carries a version 3 map (`sources` = the filename given, `sourcesContent` included) that
already accounts for the prelude and the edits of the second pass. `Error.stack` is not
remapped by browsers; a runtime that wants mapped traces applies the map itself.

### `import()` outside modules

Code created with `new Function`, `eval` or `vm` has no `__bat` in scope. Transform it with
`force_kind: CommonJs` and `options.dynamic_import` set to a global hook (for example
`globalThis.__bat_import`): `import(x)` is then rewritten to that name instead of
`__bat.import`. The transform cannot see such code by itself; the runtime's `Function`
and `vm` implementations have to route through it.

## 2. CommonJS

Header (normative):

```js
(function (exports, require, module, __filename, __dirname, __bat) {<code>
})
```

Called with `this === module.exports`. The newline before `}` is required: code may end in a
line comment. The code is the source, except:

- `import(x)` → `__bat.import(x)` (extra arguments stay; the loader may ignore import
  attributes).
- a leading `#!` becomes `//`.

Nothing is prepended, so a `"use strict"` directive still works and sloppy code stays sloppy.
When nothing changed, `code` borrows the source and the facts word has `CODE_IS_SOURCE`.

JSON is CommonJS-shaped (`module.exports=JSON.parse("…");`, kind `Json`) but a loader should
not use that: read the original text and `JSON.parse` it (the reference loader does).

## 3. ES modules

Header (normative), chosen by the `ASYNC` facts bit (top-level `await`):

```js
(function* (__bat) {<code>
})
(async function* (__bat) {<code>
})
```

Called with `this === undefined`. A module is a **generator** so that it can stop once
between linking and evaluation; that one pause is what makes cycles and async dependencies
work without retries (§5). The code begins with a one-line prelude:

```js
"use strict";
__bat.exports({a:()=>a,default:()=>__bat_default,x:()=>__bat_i1.x});   // only if it exports
const __bat_i0=__bat.link("./dep.js"),__bat_i1=__bat.link("pkg");     // only if it imports
__bat.star(__bat_i1);                                                  // one per `export *`
Object.defineProperty(__bat_default,"name",{value:"default",configurable:true}); // see below
yield;
```

(all on one line) followed by the module body. Exactly one `yield` exists at the top level
of every ES module function, including modules with no imports or exports.

### The `__bat` object

One per module instance. Normative members:

| member | used by | contract |
| --- | --- | --- |
| `exports(getters)` | ESM prelude | For each own key, define an enumerable accessor on the module's namespace object whose getter is the given function. Called at most once, before anything else. Keys are already sorted by UTF-16 code unit. |
| `link(specifier)` | ESM prelude | Resolve `specifier` (ESM conditions) against this module, create the dependency's record if needed, remember it as the next static dependency, and return its **namespace object without evaluating it** (§4). Called once per distinct specifier, in source order of all `import`/`export … from` statements. |
| `star(namespace)` | ESM prelude | `export * from` the dependency whose namespace this is. |
| `import(specifier, options?)` | both kinds | `import()`: a promise for the namespace object. Never evaluates anything synchronously. |
| `meta` | ESM | The `import.meta` object: `url`, `filename`, `dirname`, `resolve(specifier)` (synchronous, returns a URL string), `main`. `env` and `hot` are not defined here: guest code that uses them (Vite SSR output) gets them from Vite's own transform, and leaving them `undefined` keeps a missing transform loud. Create it lazily; most modules never ask. |

### Rewrites in the body

Decided on the AST with resolved scopes (a local that shadows an import is untouched):

| source | output |
| --- | --- |
| `import d, { a as b } from "m"`, `import * as ns from "m"`, `import "m"` | removed; `__bat_iN=__bat.link("m")` in the prelude |
| a reference to `b` | `__bat_iN.a` (read at every use: live) |
| a reference to `d` / `ns` | `__bat_iN.default` / `__bat_iN` |
| `b(x)`, `` b`t` ``, `(b)(x)`, `b?.(x)` | `(0,__bat_iN.a)(x)` …: the namespace is never `this` |
| `{ b }`, `({ b } = v)` | `{ b:__bat_iN.a }` |
| `export const a = 1`, `export function f(){}`, `export class C {}` | `export ` removed; getter `a:()=>a` |
| `export { a as b }` | removed; getter `b:()=>a` (or `b:()=>__bat_iN.x` if `a` is an import) |
| `export { x as y } from "m"` | removed; getter `y:()=>__bat_iN.x` |
| `export * as ns from "m"` | removed; getter `ns:()=>__bat_iN` |
| `export * from "m"` | removed; `__bat.star(__bat_iN)` |
| `export default function f(){}` / `class C {}` | declaration kept; getter `default:()=>f` |
| `export default function(){}` | `function __bat_default(){}` (still hoisted), renamed to `"default"` in the prelude |
| `export default <expr>` | `const __bat_default=<expr>`; an anonymous function/class/arrow is wrapped as `({default:<expr>}).default` so its `name` is `"default"` |
| `import.meta` | `__bat.meta` |
| `import(x)` | `__bat.import(x)` |
| leading `#!` | `//` |

Consequences worth knowing:

- Export getters read local bindings, so a binding still in its temporal dead zone throws
  `ReferenceError` through the namespace, as in real ESM, and function declarations are
  readable as soon as the prelude has run.
- ES modules get **no** `require`, `module`, `exports`, `__filename`, `__dirname`. A module
  may declare its own (`const require = createRequire(import.meta.url)`), and `typeof
  require` is `"undefined"` as in Node. The facts say whether a module references them free.
- `__bat` and any identifier starting with `__bat` are reserved. A source that declares or
  references one is rejected with an error diagnostic.
- Not supported: direct `eval` that names an imported binding (the name no longer exists).

## 4. Namespaces and interop (loader, normative)

**Namespace of an ES module**: a null-prototype object with `Symbol.toStringTag` =
`"Module"`, created with the record, filled by `__bat.exports` and by `export *` resolution.

**`export *`** from namespace `N` adds every name of `N` except `default` that the module
does not export itself. Reference only: names offered by two `export *` resolve to the first
(the spec excludes them as ambiguous), and star names are appended after the module's own
names instead of being merged into sorted order.

**`import` of anything that is not an ES module** (CommonJS, JSON, builtin) gets a namespace
built by Node's rules:

- `default` is `module.exports`, always. `__esModule` does not change that.
- `"module.exports"` is `module.exports` too (Node 23+).
- one live accessor per statically detected export name: `facts.exports`, plus the names of
  every module in `facts.reexports`, transitively (resolved with `require` conditions).
  For a builtin: its own enumerable keys.

The namespace exists before the module runs (names are static), so it can be handed out by
`link`. A loader may additionally expose own enumerable keys it finds after evaluation; the
reference loader does not, so that it behaves exactly like Node.

**`require()` of an ES module** (Node 22+ rules): link it, throw `ERR_REQUIRE_ASYNC_MODULE`
if it or any not-yet-evaluated static dependency has the `ASYNC` bit, evaluate it, then
return the `"module.exports"` export if it has one; otherwise the namespace itself, unless it
has a `default` export and no `__esModule` export, in which case return an object with the
same live names plus `__esModule: true`.

**`require()` of CommonJS**: Node's: run once, cycles see the exports so far, a module that
throws is forgotten.

## 5. Linking and evaluation (loader, normative)

Per ES module record: `NEW → LINKING → LINKED → EVALUATING → EVALUATED`, or `FAILED`.

**link(record)** (if `NEW`): create the generator by calling the function with `__bat`;
call `.next()` once. That runs the prelude to its `yield`: export accessors are defined,
`link` has been called for every dependency, function declarations are hoisted. Then link
every ES-module dependency recursively, then resolve `export *`. Linking never runs a body.

`.next()` on an async generator returns a promise and cannot throw synchronously: `link`
must record a resolution failure itself and report it after the prelude (the reference
loader stores it in `record.error` and returns an empty namespace to the prelude).

**evaluate(record)**: if already evaluating or evaluated, return the record's pending
promise, if any (an ancestor in a cycle is not waited for). Otherwise evaluate every static
dependency in order (CommonJS dependencies are simply run), collecting the promises of those
that are not finished. If there are none, call `.next()` again: that is the body. For a
plain generator the module is evaluated when it returns; for an async generator `.next()`
returns the promise of its completion. If dependencies are pending, the body runs after all
of them. `evaluate` returns `undefined` when everything completed synchronously, else a
promise; an error is stored and rethrown to every later importer.

What this gives, with no recompile and no retry:

- **Cycles**: by the time any body runs, every module of the static graph has its accessors
  and hoisted functions. An importer evaluated first can call a function declaration of a
  module that has not run yet, and that function sees its own imports, because the
  `__bat_iN` namespace constants were initialised in the prelude.
- **Top-level await**: the module's function is async. `import()` awaits it; a synchronous
  module that statically imports it waits for it too (its own body is resumed later,
  although its function is not async); `require()` of such a graph throws.

**Dynamic `import()`**: resolve with ESM conditions, then for an ES module link, await
evaluate, return the namespace; for anything else run it and return the interop namespace.

## 6. Facts

`Output.facts`; compact form = one `u32` word + optional blob. Bits 0–16 are defined here,
17–23 are reserved for this crate, 24–31 belong to the image format.

| bits | name | meaning |
| --- | --- | --- |
| 0–2 | kind | 1 CommonJS, 2 ES module, 3 JSON (0: unknown) |
| 3 | `ASYNC` | ES module with top-level await → `async function*` |
| 4 | `IMPORT_META` | uses `import.meta` |
| 5 | `DYNAMIC_IMPORT` | uses `import()` |
| 6–10 | `USES_REQUIRE`, `USES_MODULE`, `USES_EXPORTS`, `USES_FILENAME`, `USES_DIRNAME` | references that name free (ESM: exact, from scope analysis; CommonJS: by name, may over-report) |
| 11 | `ES_MODULE_MARKER` | CommonJS that sets `__esModule` |
| 12 | `HAS_DEFAULT` | ES module with a `default` export |
| 13 | `HAS_REEXPORTS` | `reexports` is non-empty: names are incomplete until followed |
| 14 | `CODE_IS_SOURCE` | code is byte-identical to the source |
| 15 | `HAS_BLOB` | a blob follows |
| 16 | `LOWERED` | TypeScript/JSX was lowered; lines differ from the source |

Blob: five string lists in this order, each a LEB128 count followed by that many strings,
each a LEB128 byte length and UTF-8 bytes:

1. `imports`: ES module `__bat.link` specifiers, in link order.
2. `dynamic_imports`: `import("literal")` specifiers.
3. `requires`: `require("literal")` specifiers at any depth, in both kinds; the callee is
   matched by name, so a shadowed `require` over-reports.
4. `exports`: ES module: exact own export names, sorted, without `export *` names.
   CommonJS: statically detected names in source order.
5. `reexports`: ES module: `export * from` specifiers. CommonJS: modules whose exports are
   re-exported wholesale.

`Facts::encode_blob` / `Facts::decode` in Rust, `decodeFacts(word, blob)` in
`crates/bat-modules/js/facts.ts`. For the TODO guest tree the blobs total 0.6 MB.

### CommonJS export detection

The AST equivalent of Node's `cjs-module-lexer`, at any nesting depth: `exports.x =`,
`module.exports.x =`, `exports["x"] =`; `Object.defineProperty(exports, "x", { value | get })`;
`module.exports = { a, b: c, "d": e, ...require("x") }`; `module.exports = require("x")`;
`__exportStar(require("x"), exports)`, `tslib.__exportStar(…)`, `__export(require("x"))`;
Babel's `Object.keys(_x).forEach(k => exports[k] = _x[k])` with `_x = require("x")`.

It is held to one property: **every name or re-export Node 24's own lexer reports is in the
facts** (`harness/compare-cjs-lexer.mjs` checks this against Node's internal binding). That
required reproducing three lexer quirks that real packages trip: `module.exports =
require("x")(…)` counts as a re-export of `x`; an object literal whose first value is
`require("x")` re-exports `x`; `exports.x === y` counts as an export of `x`. Extra names are
harmless (the accessor reads `undefined`), missing ones break `import { x }`.

## 7. WebAssembly build

`crates/bat-modules/build-wasm.sh` → `crates/bat-modules/js/bat_modules.wasm`
(wasm32-unknown-unknown, no imports, no wasm-bindgen). Exports:

```text
memory
bat_alloc(len) -> ptr
bat_free(ptr, len)
bat_transform(src, src_len, name, name_len, opts, opts_len) -> result
bat_result_free(result)
```

`result` → ten little-endian `u32`: `ok`, facts word, code ptr/len, blob ptr/len, map
ptr/len (len 0 = none), diagnostics ptr/len (UTF-8 lines `E|W \t line \t column \t message`).
Unchanged code points into `src`, so free `src` after reading the result. `opts` (may be
empty): `u32` flags then four length-prefixed strings (jsxImportSource, jsxFactory,
jsxFragmentFactory, dynamicImport); flag bits are listed in `wasm/src/lib.rs`.

`crates/bat-modules/js/transform.ts` wraps this as
`createTransform(wasm) → (source, filename, options?) → { ok, code, facts, map, diagnostics }`
(synchronous after instantiation; one instance per worker; on a `WebAssembly.RuntimeError`
discard the instance).

## 8. Program scripts

Prepare may ship compiled modules as a classic script of `__bat_define(path, fn)` calls
(`docs/design/image-format.md`). `fn` is the same body under the same header as above;
nothing in the code depends on how the function was created.

## 9. Verification

In `crates/bat-modules/harness` (Node 24, `node --experimental-import-meta-resolve`):

- `run.mjs`: every module is transformed by the Wasm build and evaluated by `loader.mjs`;
  only builtins and native `.node` addons come from Node. Scenarios: Vite 7
  (`dist/node/index.js` and chunks, `resolveConfig`, and a dev server that listens and serves
  a TSX module and a Tailwind stylesheet), `@react-router/dev/vite`, `@tailwindcss/vite`,
  `@babel/core`, `react-dom/server`, a TSX component, a circular pair with live bindings,
  top-level await (direct, and through a synchronous importer), named imports from
  CommonJS, JSON, `export *`, `require(esm)`, and an edge-case graph whose results are
  compared with the same graph run by Node itself.
- `opencode.mjs`: the 27.7 MB OpenCode server bundle, to `GET /api/health → 200`.
- `check-tree.mjs DIR`: transform every file of a tree and compile each result in V8.
- `compare-cjs-lexer.mjs DIR` (`node --expose-internals`): CommonJS facts ⊇ Node's lexer.

## 10. Async context hooks (`Options::async_context`)

Added by the node runtime. Off by default; `bat-prepare` and the runtime's Wasm calls
(option flag bit 11) turn it on. Every `await x`, in both module kinds and at any depth, is
written

```js
__bat_u(await __bat_w(x))
```

as three insertions, so the operand's text, lines and inner rewrites are untouched and a
module that contains `await` no longer has `CODE_IS_SOURCE`. `__bat_w` and `__bat_u` are
globals the runtime defines (`runtime/src/node/async_hooks.ts`): identity functions until
an `AsyncLocalStorage` exists; afterwards `__bat_w` returns a promise that always fulfils
with the outcome of `x` paired with the current context frame, and `__bat_u` restores that
frame and returns the value or rethrows. A loader without async context defines both as
`(v) => v`. `for await` and `await using` are not instrumented.

Also changed in §3's rewrite table: a call (or tagged template) whose callee is an import
and which is the first token of an expression statement is written
`void 0,(0,__bat_iN.a)(x)`. A leading `(` would continue the previous line when that line
has no semicolon.
