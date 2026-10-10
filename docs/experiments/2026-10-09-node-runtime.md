# Node runtime: what runs, and what it costs (2026-10-09)

Branch `rewrite/rust`. Chrome 154 on diesel2 (12 cores), headed on Xvfb, driven through
`browser-control` session `bat-node`, harness on port 4102. The machine was running other
agents' builds throughout; the 1-minute load average is given with each number. All
numbers come from `bun runtime/harness/measure.ts` (which prints the raw samples) unless a
command is shown. Image: the TODO guest tree prepared with this branch's `bat-modules`
(`target-runtime/prepared/todo`, 234 MB, 15,6xx entries).

## How to reproduce

```sh
bun runtime/build.ts                       # runtime/dist/
bun runtime/harness/cli.ts reload          # starts the server (4102) if needed, boots the page
runtime/harness/check.sh                   # every guest in runtime/harness/guests
bun runtime/harness/measure.ts             # all scenarios below; or: spawn cold typescript vite program
```

`runtime/harness/cli.ts` is the day-to-day tool:

```sh
bun runtime/harness/cli.ts run path/to/script.mjs [args]     # host file (and its siblings) copied into the guest, run with node
bun runtime/harness/cli.ts run -e 'console.log(process.version)'
bun runtime/harness/cli.ts run --guest /app/server.js        # a file already in the guest
bun runtime/harness/cli.ts node -p '1+1'                     # raw node command line
bun runtime/harness/cli.ts launch agent|preview              # entry, args, cwd, env from manifest.launch
bun runtime/harness/cli.ts start launch preview              # background: prints the pid
bun runtime/harness/cli.ts status <pid> | stop <pid>         # output so far / kill
# options: --trace (loader, resolver, loop counters) --timeout MS --env K=V --cwd DIR --stdin TEXT
#          --keep-stdin --reload --build --query 'spare=0&debug=beat' --json
```

## What runs

| Program | Result |
| --- | --- |
| CommonJS script: fs round trips, fds, symlinks, `cp`/`rm` recursive, timers, streams, `process` events (`guests/cjs.cjs`) | passes |
| ES module with top-level await, JSON import, CJS interop both ways, `import()`, `import.meta`, a cycle (`esm.mjs`) | passes |
| TypeScript from the overlay, importing `./x` and `./x.js` for `x.ts`, top-level await (`ts-main.ts`) | passes; 12–14 ms for the whole process |
| `child_process`: `spawnSync(process.execPath)` with input and captured output, `spawn` with pipes, `exec`, `execFileSync`, a `.bin` shim (`vite --version`), ENOENT, exit codes, `fork` with IPC, SIGKILL (`spawn.cjs`) | passes |
| Process lifetime: exit codes, uncaught error, unhandled rejection, handlers, `unref`, `beforeExit`, signals, unsettled TLA → 13, `-p` (`semantics.cjs`) | passes (18 cases) |
| `fs.watch` on a file, a directory, recursive; a due timer runs before the next watch event (`watch.cjs`) | passes |
| `AsyncLocalStorage`: three interleaved flows across `await`, timers, `fs`, immediates, `nextTick`, promise chains, a child's exit, nested `run`, `AsyncResource.bind`; a continuation resumed from another context (`als.mjs`) | passes: 49 checks, cross-context resume kept |
| `require('typescript')` 5.9.3, `transpileModule`, a `createProgram` (`typescript.cjs`) | passes |
| `@babel/core` 7.29.7 `transformSync` with `plugin-syntax-jsx` and `preset-typescript` on TSX (`babel.cjs`) | passes. The guest tree has no JSX-lowering Babel plugin (React Router lowers JSX elsewhere), so JSX is parsed and printed, TypeScript is stripped |
| `react-dom/server` `renderToString` and `renderToPipeableStream` (`react-ssr.mjs`) | passes |
| `import('vite')` + `resolveConfig` for `/workspace` with the TODO source, native config loader (`vite-config.mjs`) | passes: 43 plugins (React Router, Tailwind, the toolkit's) |
| `vite --configLoader native --host 0.0.0.0 --port 5173 --strictPort` (`launch preview`) | "VITE v7.3.6 ready in 575–757 ms". From a second guest process: `GET /preview/5173/` → 200, 14 KB of server-rendered HTML (426 ms first request); `/@vite/client`, `/src/root.tsx` (React Refresh applied), `/src/style.css`, three optimized deps → 200 |
| `node /app/server.js` (OpenCode 2.0.3, 27.7 MB) with `launch.agent` env (`launch agent`) | 47 migrations run in `node:sqlite`, `OPENCODE_SERVER_PROCESS_READY`; from a second process `GET /api/health` with Basic auth → 200 `{"healthy":true,"version":"2.0.3"}`, without → 401; guest `fetch` to the loopback port → 200 |
| `rg` through `child_process` with `PATH=/app/node_modules/.bin` | `rg --version` 0 (367 ms first run), a search of `src` 74 ms |

`net`, `http`, `https`, `fetch` routing and `node:sqlite` in those runs are the other
agents' modules, plugged in through `runtime/src/<dir>/builtins.ts` (see "Registration").

Where the two guests stopped, and why:

- **Vite** did not stop inside this runtime's surface. Not exercised here: the preview
  iframe, HMR over the WebSocket shim, a browser actually hydrating the page.
- **OpenCode** then died with an uncaught `write EPIPE` when a client went away before the
  response was written (`ServerResponse._write` → `'error'` with no listener, in
  `runtime/src/net/http.ts`). Node swallows that case. Plugins, the event stream and the
  tools were not driven.
- With stdin closed at once OpenCode shuts down by itself (its launcher stops on stdin
  EOF): a host must keep stdin open (`--keep-stdin`, or `start`).

## Numbers

### Spawn

Spawn request on the page (`kernel.spawn`) to the first guest statement, measured as
`performance.timeOrigin + performance.now()` in the guest minus the same on the page.

| | n | min | median | max | load |
| --- | --- | --- | --- | --- | --- |
| Warm spare: spawn → first statement | 15 | 1.9 ms | **2.3 ms** | 8.0 ms | 11.1 |
| Warm spare: spawn → exit seen by the page | 15 | 2.8 ms | 3.5 ms | 9.1 ms | 11.1 |
| Warm spare: `run` message → entry starts (inside the worker) | 15 | 0.57 ms | 0.85 ms | 1.4 ms | 11.1 |
| Cold worker (no spare): spawn → first statement | 10 | 45 ms | **54 ms** | 66 ms | 10.7 |
| Cold worker: spawn → exit | 10 | 62 ms | 71 ms | 87 ms | 10.7 |

Budget was 20 ms with the warm spare; the old runtime took 140–240 ms per process. The cold
case is a new Worker, `bat-process.js` (403 KiB, 99 KiB gzip) and `bat-nodelib.js`
(496 KiB, 93 KiB gzip) from the HTTP cache, kernel attach, image handle, and evaluating
nine builtins. kerneld keeps one spare, so a chain of `spawnSync` calls faster than a spare
can be made pays the cold price from the second child on (seen in `spawn.cjs`: 55–115 ms per
`spawnSync(node)` including the child's own run).

### Loading modules

| | n | min | median | max | load |
| --- | --- | --- | --- | --- | --- |
| `require('typescript')` (one 9.1 MB CommonJS file, precompiled body in the image) | 6 | 138 ms | **147 ms** | 171 ms | 9.9 |
| … of which reading 9.1 MB out of the image | | | 13 ms | | |
| … of which V8 compiling the wrapper (`eval`) | | | 118 ms | | |
| `ts.transpileModule` of a snippet, first call | 6 | 28 ms | 30 ms | 32 ms | 9.9 |
| `import('vite')` | 6 | 74 ms | **81 ms** | 96 ms | 9.9–11 |
| `resolveConfig` for `/workspace` | 6 | 259 ms | **286 ms** | 353 ms | 9.9–11 |
| whole process (spawn → exit) for the two together | 6 | 338 ms | 375 ms | 456 ms | 9.9–11 |

For the Vite run: 576 modules (489 CommonJS, 57 ES, 2 JSON, 28 builtins). 480 used their
source as the function body (`CODE_IS_SOURCE`), 63 a stored compiled body, 3 were
transformed at load (the workspace's TypeScript config files; 1 ms, then served from the
content cache in `/.bat/cache`). 6.0 MB read in 21 ms; V8 compile of the 546 wrappers 118 ms.

### Resolution

| | value |
| --- | --- |
| Resolutions for `import('vite')` + `resolveConfig` | 1,138 (identical in 6 runs) |
| … answered by the process's own map (same specifier from the same directory) | 415 |
| … answered by the kernel's Rust resolver | 723 |
| Total time in resolution | **8.8 ms** median (7.8–13.8), 12 µs per kernel call |
| `stat` calls made by the resolver | 2.4 per kernel resolution (10,634 for 4,351 calls since boot) |
| package.json reads | 169 over all runs; 11,778 answered by the kernel's package cache |

The old runtime spent 2,429 resolutions and 34,000 stats (3.6 s, later 0.2 s) on one Vite
start. The kernel's cross-process *result* cache got 9 hits in 4,351 calls: its entries
are dropped whenever the overlay generation changes, and something in every run changes
it (the harness writes the guest script; Vite writes its temp files). At 12 µs per miss
this was not pursued.

### The OpenCode program script (27.7 MB) and the V8 code cache

`manifest.programs[0]` loaded before `/app/server.js` runs. "load" is the fetch + compile
of the script up to its `__bat_define` call; "start" is from there to the end of the
module's synchronous part (V8 compiling the functions it runs). Six processes in a row,
then a page reload and three more; a fresh URL per row so every row starts with no cache.

| How the worker loads it | Served | load, loads 1…6 (ms) | after reload (ms) | start (ms) | process total, steady (ms) | load avg |
| --- | --- | --- | --- | --- | --- | --- |
| `import(url)` as a module | HTTP cache, `immutable` | 843, 502, **216, 231, 224, 234** | 238, 229, 227 | 136, 152, then **5** | **≈ 435** | 14 → 11 |
| `importScripts(url)` | HTTP cache, `immutable` | 998, 635, 648, 669, 790, 771 | 804, 702, 722 | 143–184 every time | ≈ 1,550 | 11 → 8 |
| `import(url)` | HTTP cache, `no-cache` (ETag) | 1264, 626, **243, 234, 278, 259** | 241, 265, 237 | 217, 237, then **5** | ≈ 470 | 8 |
| `importScripts(url)` | HTTP cache, `no-cache` | 1021, 632, 702, 633, 1145, 1052 | 785, 681, 753 | 142–236 every time | ≈ 1,600 | 8 |
| `importScripts(url)` | `no-store` | 1057, 956, 680, 667, 676, 716 | 974, 1075, 1105 | 140–251 every time | ≈ 1,500–2,600 | 8 |
| `import(url)` | service worker, Cache Storage | 962, 648, 796, 765, 851, 745 | 571, 629, 572 | 140–251 every time | ≈ 1,400–2,100 | 8 |
| `importScripts(url)` | service worker, Cache Storage | 916, 812, 689, 642, 796, 634 | 668, 664, 720 | 138–216 every time | ≈ 1,500 | 6–8 |

Plainly:

- **`importScripts` never gets a code cache** in a dedicated worker in Chrome 154: no
  step down on any load, with long-lived immutable caching, with revalidation, or through
  a service worker. About 650–800 ms to load plus 150 ms to start, every process.
- **`import()` of the same file from the HTTP cache does**, from the third load (V8's
  cold → warm → hot rule): 230 ms to load and 5 ms to start, and it survives a page
  reload. That takes the OpenCode process from about 1.5 s to about 0.43 s for
  "spawn → migrations checked → listening → shut down on stdin EOF".
- **A service worker answering from Cache Storage produced no code cache** with either
  loader in this simple form (`cache.put` on first fetch, outside the `install` event).
  Chrome is said to code-cache Cache Storage scripts that are stored during the worker's
  `install` event; that variant was not tried, because the HTTP cache already works.
- The first load of a new program URL is no faster than before (0.85–1.3 s).

So the worker now loads the *entry's* program with `import()`; see the decision record.
A program reached later, in the middle of synchronous loading, still needs
`importScripts`.

## Registration point for other builtins

`runtime/src/node/registry.ts`: `registerBuiltin(name, (rt) => exports, { schemeOnly?, hidden? })`.
`runtime/build.ts` imports every `runtime/src/<dir>/builtins.ts` into the process bundle
after this agent's own, so a later registration replaces the placeholder (`net`, `http`,
`https`, `sqlite` have placeholders that load and say on stderr what was called). The
factory gets the `Runtime` (`runtime/src/process/runtime.ts`): kernel binding, the event
loop (`ref`/`unref`, `onFd`, `onChild`, `onWatch`, `defer`, `nextTick`, `call`, `bind`),
builtin `require`, `wasmModule(name)` for a Wasm helper named in the worker URL's config.
Names in `config.prewarm` are required in the warm spare (the host uses this for
`bat:net-globals`).

## Bugs found on the way (all fixed, all in others' paths; each has its own commit)

| Where | What | Seen as |
| --- | --- | --- |
| `bat-modules` ESM rewrite | a rewritten callee at the start of a statement (`(0,ns.f)()`) continued the previous line when it had no semicolon | `TypeError: __bat.import(...) is not a function` in a semicolon-free module; images had to be prepared again |
| `bat-kernel` `proc::finish` | exit status stored after the fds were closed | `spawnSync` reporting status 0 for `process.exit(4)`, intermittently |
| `kerneld.ts` `retire` | a worker that posts `exited` *and* is reported by the kernel is retired twice; the thread record is freed twice 5 s later | the page's main thread spinning forever on a kernel lock a few seconds after some runs. **Not fixed in kerneld**: the node worker simply no longer posts `exited`. `retire` should be made idempotent |

## Not verified

- Nothing was run in Firefox or Safari.
- The runtime was only driven from the harness page, not through the toolkit's
  `openEditor` path, a service worker preview, or with overlay persistence on.
- `worker_threads.Worker` (not implemented), `vm` contexts beyond `with`-scoping,
  `readline` on an interactive terminal, `fs.watchFile`, `fs.promises.watch`, `fs.cp`
  filters, `process.stdin` back-pressure with large inputs, BigInt stats, and the crypto
  and zlib surfaces inside the browser beyond what Vite and OpenCode touched while starting
  (they were verified against Node natively by `runtime/harness/native-check.ts`).
- The kernel resolver was compared with Node 24.18 natively (9,143 cases, 0 mismatches;
  generator kept in `runtime/harness/resolve-check/`), not through the Wasm build.
- Memory: no measurement of what a process worker costs, or of the spare.
- `--conditions`, `--require`/`--import` preloads and `NODE_OPTIONS` are parsed; only
  `--require` was exercised.
