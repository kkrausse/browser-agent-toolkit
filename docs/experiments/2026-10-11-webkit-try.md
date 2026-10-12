# A build to try in Safari on a phone (2026-10-11)

Branch `webkit-try`, cut from `webkit-support` at `c8ab34c`. It joins the day's WebKit work
into one tree and makes a static build that can be opened on an iPhone over the tailnet.
**Sections 1 to 6 were written before anything had run in Safari or on iOS; section 7 is the first try on both.** "WebKit" below is Playwright's Linux build
(`webkit-2370`, WebKit 27.2), headless; Chrome is 154 through `browser-control`. Machine load
4 to 9 throughout.

## 1. What is in the tree

| Merged | Commit | What it brings |
| --- | --- | --- |
| `origin/webkit-perf` | `9345774` | start-up: program modules started at load, SQLite heap steps, the arriving image read through snapshots |
| `ios-memory` (local branch, its worktree still in use) | `c057c67` | kernel memory of fixed size (256 MiB, never grown), image chunk cache with a limit, a merge of `main` |

Conflicts that needed a decision:

- `crates/bat-kernel/src/alloc.rs`: `ios-memory`'s side. `webkit-support` made the heap grow
  in 64 MiB steps so that the JavaScriptCore grow fault (webkit report, 9.1) is met rarely;
  a memory that is never grown does not meet it at all, and `ios-memory`'s allocator keeps
  the 64 MiB step for an embedder that asks for a growable memory.
- `examples/todo-fullstack/demo/webkit.ts` (added on both sides): `webkit-support`'s copy,
  the later one (the `Vary` check of section 10 and the kept preview log). The rest of the
  example was identical on both sides.
- `docs/design/decisions.md`: both sides, in order.

`bun.lock`, `kerneld.ts` and `opfs.ts` merged without conflict.

## 2. Checks on the merged tree

Everything rebuilt from this tree (`bun run setup`, prepare of each example).

| Check | Chrome | WebKit |
| --- | --- | --- |
| `runtime/harness/check.sh` | 12 of 12, twice (after the merge; after the runtime change of section 3) | 12 of 12, twice |
| `examples/terminal-app/demo/run.ts`, mock server | 1 of 1 | 1 of 1 |
| the same with `?mock=1&diag=1` (mock in the service worker, panel on) | 1 of 1 | 1 of 1 |
| `examples/todo-app/demo` (`run.ts` / `webkit.ts`), scripted model | 1 of 1 | 2 of 2 |
| `examples/todo-fullstack/demo`, `MOCK_TODO=fullstack` | 1 of 1 | 2 of 2 |

No paid model conversation was made.

## 3. What was added

- `examples/terminal-app/src/diag.ts`: an on-page panel (README, "Trying it on a phone").
  For it the runtime got two small things: `kernelMemoryBytes` in the detail of the boot
  marks (`host.ts`), and kerneld saying its failures and its process workers' on a
  `BroadcastChannel` (`bat-diag`) besides the console.
- `?mock=1`: the scripted model inside the page's service worker (`mock-script.ts`).
- `?kmem=<MiB>`: the kernel memory's size from the address.
- `examples/terminal-app/build-phone.ts` and `phone/`: the public build with the panel on,
  an index, and the three probes as pages.

## 4. The build on a static host

`bun build-phone.ts` writes `dist-phone/` (45.3 MB; the first open of the demo fetches all
of `demo/`, 45.25 MB, of which the dependency image is 37.4 MB). Served from a plain file
server under `/artifacts/bat-webkit/` on this machine, and from the tailnet shelf
(`deploy-artifact.sh`, https, HTTP/2):

- The host sends no COOP/COEP; the demo's `sw.js` and the probes' `sw.js` add them, each
  page reloading once. `crossOriginIsolated` was true in both browsers.
- `.gz` files arrive as `application/gzip` with no `Content-Encoding`, which is what the
  demo's worker needs (it inflates them). No `.wasm` is asked of the host under that name:
  all are shipped as `.wasm.gz` and answered by the worker as `application/wasm`.
- Every URL is relative: the sub-path needed nothing.

Against the deployed address:

| | Chrome | WebKit |
| --- | --- | --- |
| demo scenario with `?mock=1` (open, todos, prompt, three edits, hot update) | 1 of 1, open 2.4 s | 1 of 1, open 4.4 s |
| demo opened with an iPhone 15 viewport and user agent: `?mock=1&reset=1`, `?mock=1`, `?reset=1` | not run | terminal mounted in 3.5 s, 1.8 s, 1.5 s; isolated; no error |
| `probes/features.html` | as expected (shared handles) | as `probe.ts` (exclusive handles), memories up to 1 GiB made |
| `probes/preload-reuse.html`, 20 loads | not run | stale 19, 19, 0, 0 (no-cache, no-store, no-link, `Vary: *`) |
| `probes/grow-crash.html` | not run | from the local server only: control finished, race crashed the page |

Also from the local server under the sub-path: the demo scenario in WebKit 3 of 4; the
failure was the scenario's `warm` step evaluating while the page reloaded itself for
isolation in a new profile ("Execution context was destroyed"), not seen in three further
runs, two of them with new profiles.

## 5. What may fail on an iPhone and was not testable here

- **The 256 MiB shared memory.** Playwright's WebKit reserves its cage at start, so nothing
  about iOS's limits shows here. `?kmem=128` is the way around a refusal.
- **Memory pressure.** The whole tab is three or four workers, a 27 MB module function parsed
  by JavaScriptCore, and the image arriving through the service worker's
  `DecompressionStream`. A tab killed by the system says nothing; the panel's "previous
  load" is what is left of it.
- **Storage.** The image is 204 MB inflated in the origin's private file system; the quota
  here was 1,000 MiB. Private Browsing has no OPFS; Lockdown Mode has no WebAssembly.
- **Service worker streaming.** The 37 MB image passes through a `DecompressionStream` in the
  worker as it arrives; Safari stopping an idle or slow worker mid-stream was not tried.
- **Lifecycle.** A backgrounded tab's workers are suspended; kerneld holds the only image
  handle. Not considered yet (webkit report, section 7).
- **The keyboard.** The terminal takes input from a focused `contenteditable`; the iOS
  on-screen keyboard has no ctrl, so `ctrl+p` (the client's command list) needs a hardware
  keyboard. The client's bundle has the same entries as slash commands (`/connect`,
  `/models`), which need none; that they work from an iOS keyboard was not tried. Typing a
  prompt and Enter is all the scripted model needs.
- **Layout.** At phone width the terminal panel covers the app; **Close** shows the app,
  **OpenCode** brings the terminal back.

## 6. A model on the phone

- **`?mock=1`** needs nothing: no key, relay or sign-in, and no network once the files are in.
- **As published** (no `?mock`, no `?model`): OpenCode's free hosted model. The phone must
  reach the internet: `opencode.ai` and `models.opencode.ai` by the tab's own fetch, and
  `wss://wisp.mercurywork.shop/`, the public Wisp server that carries the model calls. No
  key. Not run from this origin (it would have been a model conversation); that server
  accepted an origin it had never seen on 2026-10-11 (decisions, the Wisp entry).
- **A ChatGPT plan**: `/connect` (or ctrl+p, Connect an integration), OpenAI, sign in with a
  code; type the code on OpenAI's page in another tab. Calls go to `chatgpt.com` through the
  same Wisp server. Tried by hand in Chrome on the published page, never on a phone.
- **A key of your own** is typed in the client (`/connect`), not in the cog's form, which
  has the relay address and the reset only. Unverified in this build (README, "Your own
  key"): the provider must answer the tab's preflight, and `api.openai.com` is not among the
  hosts the public build tunnels.
- **Another relay**: `?wisp=wss://…` or the cog's field; `?tunnel=wss://…` for a relay of
  `packages/relay`, whose `RELAY_ORIGINS` must then list the page's origin. No relay or
  default was changed for this build, and no key is in it.

## 7. The first try on an iPhone, and what it took

iPhone, iOS 18.7, Brave (WebKit), the deployed build with `?mock=1`: 256 MiB of kernel memory,
the dev server listening at 938 ms, OpenCode healthy at 1,556 ms, the scripted reply to
`hello`. **The TODO app was blank.**

**Cause, reproduced in the iOS 18.3 simulator (Safari) on the user's Mac.** The frame's
document stayed `interactive` with `#root` empty: 9 module requests had arrived, and
`react-dom_client.js` and `chunk-….js` never did, although the dev server had answered both
(`res 200` in the runtime trace). Those two are the only bodies over 256 KB, which the
preview bridge sends as a transferred `ReadableStream`; iOS 18 cannot transfer one
(decisions, "a preview body crosses a port"). The same build with the fix draws the app
there. The phone's own trace had the same shape (everything 200, blank app) but no readout
of the frame, so that it is the same fault on 18.7 is an inference until a readout from the
phone says `stream transfer: NO` and `app: 22 nodes`.

Ruled out in the simulator: the frame being 0 px wide while the terminal covers the page
(`?layout=old` and the new layout failed alike before the fix, and both work after it).
Not reproducible there: Brave's injected wallet script. An exception in an injected script
ends that script only; the frame's modules are separate scripts and do not depend on it.

Also found there: on iOS before 18.4 the OpenCode server died at start (`Can't find
variable: Iterator`, fixed); and with a workspace of the simulator's first runs the client
opened on "Connect an integration", which took the `?auto=` prompt, so the scripted edit
turn was **not** run on iOS. Not looked into.

**What changed in the build** (`examples/terminal-app`):

- The panel sends its readout to a collector (`diag-collector.ts`; `DIAG_URL` at build
  time or `?diag=<url>`): the Send button, and by itself once the terminal is up, on an
  error, when the app's frame changes and on pagehide. It needs https from an https page:
  `tailscale serve --bg --https=4319 http://127.0.0.1:4319` on the collecting machine.
- The readout starts with the last error and the app's frame (box, what covers it, scroll
  offsets, readyState, `#root`, body, the dev client's websocket, each request), then the
  stages; the environment is at the end. One line of it is always on the screen.
- At phone width the terminal lies over the app instead of beside it, so the frame is never
  0 px wide; closing blurs the terminal, resets the page's scroll and has the frame laid
  out again. `?layout=old` is the earlier layout, to compare.
  **Taken out again on 2026-10-12** (`ce36c3d`): the earlier layout is the only one, at every
  width, and `?layout` is gone; closing still blurs the terminal. See
  `2026-10-12-webkit-ios-summary.md`.
- `?panel=closed`, `?auto=<prompt>`, `?closeAfter=<s>`, `?diagTall=1`, `?diagPage=<s>`: a
  simulator that nothing can tap, read from screenshots (`ios-build sh xcrun simctl openurl
  booted <url>`, `xcrun simctl io booted screenshot`). A page there cannot post to a plain
  http collector on the Mac's loopback (mixed content), hence the screenshots.

**Storage.** The 210 MiB that `storage.estimate` showed at the first load was not the
image: the shelf's origin is shared with other pages, and its private file system held two
speech models of another page (`pk-models/…`, 129 + 81 MiB). The image is stored once. What
makes the estimate jump is a reload while the image arrives: the next load downloads it
again into the same `.partial` file (`imageCached:false, imageArriving:true`), and WebKit's
estimate then counts both (392 to 424 MiB in Playwright's WebKit with one 194 MiB file in
the profile; back to 208 MiB after a browser restart). The panel now lists the stored
files with their sizes. An interrupted download still starts over from zero; not changed.

**Checked after the change**, deployed address, `?mock=1&reset=1`: open, `hello`, the
heading edit, Close, the app visible with "Tasks" on top of the page: Chrome 154 at
430 x 800 (4 readouts arrived at the collector over loopback) and Playwright WebKit as an
iPhone 15 Pro Max (its uploads refused as mixed content from the https page; from the same
build on `http://127.0.0.1` they arrived). `runtime/harness/check.sh` in WebKit: 12 of 12.
