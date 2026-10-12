# autoanimate's check, lint and find in the guest (2026-10-12)

Feasibility spike for porting autoanimate's authoring loop to the in-browser guest. Question:
do `check`, `lint` and `find` run as ordinary Node programs in the guest, and how fast.

**Answer: all three run, unchanged, with no change to BAT, and about as fast as natively.**
Nothing was fixed in the runtime; the host-worker fallback (question 5 of the brief) was not
needed and not investigated.

## What was run

- autoanimate at `438bf3f` (branch `bat-port`, commit `a55c36e`): `bun scene-api/guest/build.ts`
  bundles the three unchanged scripts of `scene-api/scripts` for Node (`bun build`, target
  `node`, ESM), each behind a 70-line shim of the `Bun.*` calls they make (`argv`, `file`,
  `Glob`, `gunzipSync`, `write`); `import.meta.dir` is replaced at build time; `typescript`
  stays external.
- This repo at `bc968bb` (branch `bat-port`), runtime built by `bun run setup`, the harness
  page (`runtime/harness`) in Chrome 154 through `browser-control`, the todo example's prepared
  image as the base system (`BAT_PREPARED`). The guest reports Node v24.11.0.
- `bench/autoanimate/stage.ts` gathers what the commands read at run time into one directory;
  `bench/autoanimate/run.ts` puts it in the guest under `/autoanimate` (laid out as the
  checkout is), runs `node scene-api/guest/dist/<name>.mjs …` with cwd `/autoanimate`, times
  it and samples the tab's memory.
- Scenes: `gromen-excerpt` (385 lines, 118 s of film, 135 elements) and `cowen-garicano`
  (1346 + 453 lines, 914 s, 880 elements), plus three variants of the first made for the
  diagnostics and not committed: a wrong tone name and an unused constant (type errors), a
  label drawn over another (lint error `text-overlap`), a phrase that is never spoken (error
  from running the script).

```
bun scene-api/guest/build.ts                                   # in the autoanimate checkout
bun bench/autoanimate/stage.ts <autoanimate> /tmp/aa-spike/stage gromen-excerpt,cowen-garicano
BAT_PREPARED=<…/examples/todo-app/.editor/prepared> BAT_HARNESS_PORT=4172 BAT_HARNESS_SESSION=<own> \
  bun bench/autoanimate/run.ts /tmp/aa-spike/stage --scenes gromen-excerpt,cowen-garicano --probe --out /tmp/aa-spike/guest
```

## 1. Do they run, with the same diagnostics

| command | verdict |
| --- | --- |
| `check` | runs; no fix |
| `lint` | runs; no fix |
| `find` | runs; no fix |

Verified by running: stdout, stderr and exit code of every case below are byte for byte what
the same bundle prints under native Node 24.18 (times aside): `find eiffel tower`; `check` and
`lint` of `gromen-excerpt`, `cowen-garicano` (138 warnings, 47 KB of output) and the three
variants (TS2345 and TS6133 with line and column, exit 1; `text-overlap` error, exit 1;
`'zebra xylophone' is never spoken`, exit 1). Also verified by running: the commands through
the guest's `/bin/sh` with a pipe and `$?` (`node …find.mjs bank | head -2 && node …check.mjs x;
echo exit=$?`), which is how OpenCode's shell tool would call them; and editing a scene that
came from a mounted image, then `check` seeing the edit.

Used without trouble: ESM bundles with top-level await, `require` of the 9 MB `typescript.js`
from an ESM bundle, `ts.createProgram` over the real file system (check emits the API's
declarations from `scene-api/src` on every run), `WebAssembly.Module`/`Instance` synchronously
on 1.8 MB and 1.3 MB modules, `zlib.gunzipSync`, indirect `eval` with `//# sourceURL` and
`Error().stack` (how lint finds the line of a fault).

Two things that are not the guest's doing:

- **Bun against V8, in the places lint prints.** Under bun, a fault in an element built by a
  same-file helper that returns the element directly (`const labelAt = (…) => label(…)`) is
  reported at the line that called the helper; under V8 (native node, the guest, and the
  studio's worker in Chrome, which has always been so) at the line inside the helper. Same
  messages, same count, same order. JavaScriptCore drops tail-call frames from the stack and V8
  keeps them (checked with a five-line script under both). An agent in the guest gets the less
  useful line for such helpers; the fix would be in autoanimate's `locate`, not here.
- **`bun build` with several entries** (bun 1.4.0) left `__promiseAll` undefined in entries
  sharing modules with one that imports them dynamically; the build makes one entry at a time.

Small guest difference seen, harmless here: `performance.now()` at the first line of a
program is not near zero (it was 6 to 14 s: the page's clock, not the process's), so a program
that reads it as "time since I started" would be wrong. The commands only take differences.

## 2. Time

Milliseconds, wall, from spawn to exit. Guest: cold is the first run in a fresh kernel (page
reloaded, files put in again), warm the two runs after it. Native: three runs on the same
machine (Ryzen 5 5500, 12 threads), which was busy with other work throughout (load average 5
to 9), so read differences under about 15% as noise.

| command | guest cold | guest warm | native bun | native node, same bundle |
| --- | --- | --- | --- | --- |
| `find eiffel tower` | 384 | 302, 313 | 327, 337, 336 | 374, 327, 363 |
| `check gromen-excerpt` | 1708 | 1329, 1418 | 1918, 1936, 1797 | 1552, 1557, 1544 |
| `lint gromen-excerpt` | 2051 | 1712, 1808 | 2261, 2212, 2207 | 1883, 1880, 1883 |
| `check cowen-garicano` | 1985 | 1474, 1502 | 2141, 2111, 2172 | 1771, 1719, 1750 |
| `lint cowen-garicano` | 5973 | 5878, 5835 | 5969, 5918, 5814 | 6164, 6234, 6177 |

The same from a mounted image instead of written files (section 3): find 313 / 279, 246; check
gromen 1966 / 1296, 1371; lint gromen 1949 / 1627, 1711; check cowen 1811 / 1446, 1521; lint
cowen 6029 / 5695, 5817. No difference worth the name.

Where it goes (`scene-api/guest/dist/probe.mjs`, guest, warm, ms; native node within 10%):

| stage | gromen-excerpt | cowen-garicano |
| --- | --- | --- |
| start `node`, load bundle (wall minus the stages) | about 250 | about 250 |
| load the TypeScript compiler (`require`, measured alone) | 200 to 214 | same |
| `apiPage()` (is API.md stale) | 116 | 114 |
| `sceneTypes()`: emit the API's declarations from `src`, read the lib files | 973 | 873 |
| type check the scene (again in the same process) | 169 (46) | 354 (183) |
| instantiate the two wasm | 8 + 5 | 8 + 5 |
| compile: type check, transpile, run the script against the words | 295 | 3186 |
| lint the plan | 100 | 1210 |

- The TypeScript compiler costs about 0.2 s per process to load, natively and in the guest
  alike (203, 214, 200 ms in the guest; 206, 207, 210 native node; 192 bun). An empty guest
  program exits in 4 to 8 ms with the warm spare worker.
- Half of a `check` (and a second of every `lint`) is `sceneTypes()`, which re-emits the API's
  declarations on every run. `scene-api/scripts/types.ts` already writes the result as
  `scene-types.json` (0.65 MB) for the studio; commands that read it would take about 0.9 s
  off each run and need neither `scene-api/src` nor the 100 lib files in the guest. Not built:
  it changes the scripts.
- A long film's lint is 6 s because running the scene and linting 880 elements is 4.4 s of
  wasm and script, the same natively.

## 3. What has to ship

| group | files | MB | gzip MB |
| --- | --- | --- | --- |
| bundles `check.mjs`, `lint.mjs`, `find.mjs` | 3 | 2.30 | 0.99 |
| TypeScript compiler (`typescript.js`, `package.json`) | 2 | 9.12 | 1.65 |
| TypeScript `lib.*.d.ts` | 100 | 3.14 | 0.49 |
| authoring wasm `scene_api_bg.wasm` | 1 | 1.82 | 0.48 |
| lint wasm `plan_lint_bg.wasm` | 1 | 1.33 | 0.43 |
| pictograms (`index.txt`, 114 gzipped files of drawings) | 115 | 3.88 | 2.99 |
| `scene-api/src` and `API.md` (check reads them) | 22 | 0.26 | 0.09 |
| **total** | 244 | **21.9** | **7.1** |

A scene adds its `.ts` files and `film/words.json` (0.04 MB for the short one, 0.29 MB for the
long one). The maps (countries, land, places: 0.67 MB) are inside each bundle, three times.
With `scene-types.json` in place of `src` and the lib files the total would be about 19 MB,
6.6 MB gzipped (computed, not built).

Both delivery routes work from static files, verified by running:

- **Files fetched into the guest.** The page fetched the 256 staged files and wrote them with
  the kernel's `writeFile`: 0.28 to 0.35 s to fetch from localhost, 23 ms to write 23 MB. In
  the harness the overlay is not persistent; whether the toolkit's persistent workspace keeps
  them across visits was **not verified**.
- **An image.** `bat-prepare pack <dir> --root /autoanimate -o autoanimate.batimg` made one
  23.0 MB image in 41 ms (7.4 MB with `gzip -9`, 5.9 MB with `zstd -9`); the page stored it and
  mounted it at `/autoanimate` (`storeImage` 0.38 s, `mountImage` 2 ms) beside the base image,
  which is what `manifest.layers` does for a prepared app. Files of the mount can be edited
  and added to from the guest. This is the better route for the tool itself: one request,
  cached and verified like the base image; the scene and `words.json` are the workspace.
  **Not verified**: producing that layer through `prepare`'s API (today `layers` are made by
  `bat-prepare app` for packages outside the lockfile; `pack` is a separate subcommand), and
  the manifest listing it.

## 4. Memory

The tab's renderer process as the OS sees it (`/proc/<pid>/smaps_rollup`, sampled every 50 ms),
with the todo example's image mounted, rounded:

| | RSS MB |
| --- | --- |
| idle, tool mounted as an image, first boot | 236 |
| idle, tool written as files, first boot | 336 |
| idle between commands (uncollected garbage of earlier runs) | 290 to 450 |
| peak during `find` | 300 to 410 |
| peak during `check` | 490 to 600 |
| peak during `lint` (either scene) | 510 to 645 |

So a command adds roughly 150 to 300 MB while it runs (native: bun 290 to 450 MB RSS, node 290
to 350 MB) and it goes when the process worker ends. `performance.measureUserAgentSpecificMemory()`
said 809 MB at all times: it counts the kernel's 269 MB shared memory once per realm that holds
it (page, kerneld, a worker) and does not see a finished process; not used.

## 5. Static hosting: what BAT needs from a server

Asked afterwards: the finished thing must be a directory of static files. Read from the code
(`main`, `bc968bb`, and `origin/gh-pages`), not run, except where it says so.

| need | with a server today | from static files |
| --- | --- | --- |
| cross-origin isolation | `createEditorHandler` sends COOP/COEP (`packages/toolkit/src/server.ts`) | **Exists, verified in code:** `examples/terminal-app/sw.ts` adds COOP, COEP and CORP to every response of its scope; `src/isolate.ts` registers it and reloads until `crossOriginIsolated`. `origin/gh-pages` (26 files, 45.3 MB) is that build. `openEditor`'s options do not expose the service worker (`bootRuntime` does). |
| the prepared image | served with `Content-Encoding` zstd/br, ETag, ranges | **Exists, verified in code:** the static build ships files as `.gz` and the service worker inflates them (`DecompressionStream`); the runtime fetches an image whole, no ranges. `publish-pages.ts` refuses files of 100 MB or more. Its README says the `.gz` route was not tried on Pages itself, and elsewhere that the published page works: **unverified** here. |
| model requests | the guest calls `host.internal/…/model/opencode/` with the real headers packed in `x-editor-model-headers`; the handler adds the key (`browser.ts:337`, `model-headers.ts`, `server.ts`) | **Partly.** A guest `fetch` to another host is the browser's `fetch` (`runtime/src/net/fetch.ts`), so a provider that answers CORS for OpenCode's headers can be called directly: `examples/terminal-app/src/opencode.ts` configures such a `direct` provider with a `baseURL` and `apiKey`. But the page hardcodes `apiKey: 'not-a-key'` and has no key field, and the README says a pasted key was never tried: **unverified**. By the README's own curl preflights (no real request): OpenAI, Google, Groq, DeepSeek, xAI allow the headers; OpenRouter and Mistral do not list `x-opencode-*`; Anthropic answered 400. A host without CORS needs the WebSocket tunnel (`BAT_FETCH_TUNNEL`, `packages/relay`), which is a server; the public build uses a third party's. `?mock=1` is a scripted model in the service worker, no network. |
| `host.internal` | an alias of the page's origin | only the model proxy uses it; not needed once the model URL is absolute |
| everything else | `hostPaths` forwards preview requests to the real server; asset gating and `previewHeaders` | preview service worker, OPFS, workspace lock are browser-only; a backend goes in the guest (`setGuestPaths`). No `npm install` in the guest: dependencies are in the image at build time, by the native `bat-prepare`. |

What would have to change for an autoanimate static site: build on the terminal example's
static route rather than `createEditorHandler`; add a key field and an `openEditor`-level
option for a direct provider (or use the terminal example's own config writer); pick providers
whose preflight allows OpenCode's headers, or strip `x-opencode-*` in a guest plugin
(inference, not tried). The three commands need nothing from a server either way.

## Not verified

- The commands called by OpenCode itself in the editor (only through the harness and `/bin/sh`).
- WebKit. Chrome only.
- A phone, or a machine with less memory.
- Films in sections (`sections.json`): only single `scene.ts` films were run.
- `lint --json` and the film-directory forms of `lint`; `find --all` and `--sets`.
- Everything in section 5 except what is marked as run (nothing is).
- Timings on a quiet machine.

One harness wart met on the way, not fixed: `browser-control execute` returned `null` for a
`page.evaluate` value over some tens of KB (a 47 KB stdout), so `cli.ts run` printed `null` for
the long film's lint. `bench/autoanimate/run.ts` fetches output in 16 KB pieces.
