# WebKit and iOS: where it stands (2026-10-12)

Branch `webkit-try`: `webkit-support`, `webkit-perf` and `ios-memory` in one tree, a
fast-forward from `origin/main`. This closes the pass; the detail is in the reports linked
at the end and is not repeated here. "Linux WebKit" is Playwright's build (`webkit-2370`,
WebKit 27.2), headless; it is not Safari. Chrome is 154 through `browser-control`.

## 1. What works where

| | Runtime harness (12 guest scripts) | TODO example, scripted model | Terminal example (OpenCode), scripted model |
| --- | --- | --- | --- |
| Chrome 154 | 12 of 12 | plain 1 of 1, full-stack 1 of 1 | 1 of 1; with bodies forced over a port 1 of 1 |
| Linux WebKit | 12 of 12 | plain 2 of 2, full-stack 2 of 2 | 1 of 1; with bodies forced over a port 1 of 1 |
| iOS 18.3 simulator, Safari (2026-10-11) | not run | not run | boots, app drawn; edit turn not run (section 4, item 6) |
| iPhone, iOS 18.7, Brave (reported by the user) | not run | not run | boots, app drawn, scripted `hello` answered; **edit turn not confirmed** |

The first two rows were run on `ce36c3d`, everything rebuilt from that commit, machine load
19 to 26. The deployed phone build (`?mock=1&reset=1`: open, `hello`, the heading edit,
Close, the app with "Tasks", OpenCode, Close again) passed in Linux WebKit as an iPhone 15
Pro Max and in Chrome at 430 x 800.

**One layout.** The terminal example has the layout it had before 2026-10-11 at every
width: the panel beside the app, sliding out on Close and back on the OpenCode button. At
700 px and below the panel is as wide as the page, so the app's frame is 0 px wide until
Close; the app loads and draws correctly in it all the same. The overlay tried on
2026-10-11 and its `?layout` switch are removed (`ce36c3d`).

**Diagnostics** exist only where asked for: the panel with `?diag=1`, or in a build made
with `DIAG_PANEL=1` (the phone build). The collector's address is in the phone build only.
Checked in the built files and in the page: the development build and the public build
have no `#diag` element without `?diag=1` and no collector address.

## 2. The fixes that mattered

| Commit | What |
| --- | --- |
| `90fe3c9` | Preview bodies over 256 KB cross a `MessagePort` in pieces where a `ReadableStream` cannot be transferred (iOS 18): the blank app on the phone |
| `90fe3c9` | `node:sqlite` no longer names the global `Iterator` (absent before Safari 18.4): OpenCode's server died at start |
| `ce6cf0c` | `FileSystemHandle.move(dir, name)`, the only form WebKit has |
| `7dc7c14` | No `Atomics.waitAsync` with a timeout (WebKit loses notifies); an ordinary timer is raced instead |
| `2fb757c`, `bebd975` | OPFS sync handles are exclusive in WebKit: kerneld alone holds the image, and reads an arriving image through file snapshots |
| `1837fa3` | The first download no longer blocks start-up: first-ever open 22.5 s to 3.3 s |
| `1834b0b` | The guest's `user-agent` is not sent on the browser's requests (WebKit sends it, which forces a preflight the model host refuses) |
| `7f8bf72`, then `9b05259`, `1214e7c` | Kernel memory grown in 64 MiB steps, then created at a fixed 256 MiB and never grown: the JavaScriptCore grow crash cannot be met |
| `797c8fd`, `51086e6` | SQLite's Wasm heap grows in large steps (each grow copies the memory in WebKit): about 1 s of OpenCode's start |
| `f500cf1` | A program module is started when its script loads, so JavaScriptCore parses the 27 MB function once: about 0.5 s |
| `ee606d2` | `Vary: *` on a guest's answers, so WebKit cannot reuse an earlier document's preloaded module (the lost hot update) |
| `ea42de5`, `b0b5c6a` | A process worker that came up without the page's service worker is replaced; a reference dropped outside a turn asks for a turn (webkit report 9.3) |

## 3. Numbers worth keeping

All on diesel2 under load, small samples; ranges are in the reports.

**Start-up**, TODO example, click to app visible and chat ready, median ms (webkit-perf, section 1):

| | before | after |
| --- | --- | --- |
| WebKit reopen (n = 10) | 2,786 | 2,015 |
| Chrome reopen (n = 12) | 1,540 | 1,470 |
| WebKit first open (n = 6) | 4,221 | 2,702 |
| Chrome first open (n = 22) | 1,778 | 1,837 |

WebKit's reopen is 1.37 times Chrome's (was 1.81). On the iPhone, from the one readout:
dev server listening at 938 ms, OpenCode healthy at 1,556 ms, files already stored.

**Memory**, full-stack TODO example, reopen, MB (memory-reduction, sections 1 and 7):

| | Chrome renderer (n = 2) | Linux WebKit web process (n = 3) |
| --- | --- | --- |
| open | 301 | 903 to 948 |
| after six turns | 304 (120 s idle) | 1,290 to 1,589 |
| idle | 304 | 856 to 959 |
| editor exited | 62 | 302 to 351 |
| highest resident size | 539 | 2,064 to 2,141 |

Chrome before the reductions: 348 idle, 116 exited, 608 peak. The terminal example in
Chrome was about 540 idle and 940 to 990 while the agent works (memory-footprint), not
measured again after the reductions. Caveats: none of this is Safari or iOS; the WebKit
figures are a Linux port whose collector may behave differently under iOS memory pressure;
the first-open "after" measurement was cut short; nothing was measured on the phone, where
the only fact is that the tab was not killed in a boot and one turn.

Sizes: the phone build is 45.3 MB to download, the dependency image 37.4 MB of it and
204 MB in the origin's private file system. The image is `image-27cd8dcda44aa075` and did
not change in this pass.

## 4. Open, in priority order

1. **Mobile UI (optional, a later pass).** The layout is fine on the phone as it is. An
   idea from the user: a control panel at the bottom in the style of their bun web
   terminal. Not started.
2. **Memory in WebKit is two to three times Chrome's**, and the peak during turns is higher
   with the new kernel build in 13 of 15 runs (about 2.1 GB against 1.5 GB); it falls back
   by itself, the cause was not found (memory-reduction, section 7). A footprint read on a
   real device (Xcode or a jetsam log) would replace all of it.
3. **WebKit reopen is still about 1.4 times Chrome's**: 0.3 s in OpenCode's own start-up
   code, probably module wrappers parsed again; the remedy would be in how prepare emits the
   bundle (webkit-perf, section 6).
4. **Per-worker Wasm modules**: about 21 MB per process worker in WebKit, 17 MB avoidable
   by compiling once and posting the modules. Measured, not built.
5. **An interrupted image download starts over from zero**, and a reload while it arrives
   downloads it again; WebKit's storage estimate then counts both.
6. **"Connect an integration"** opened in the simulator in place of the prompt. Seen again
   here in Linux WebKit, once: a prompt typed as soon as the input appeared, before the
   client showed its model line ("Build · scripted", about a second later), got the
   provider list. Waiting for that line, the same run passed. So probably a prompt sent
   before the client knows its model, which `?auto=` (3 s after mount) can hit on a slow
   start. One observation; not looked into further.
7. **A turn with a real model on the phone.** Only the scripted model has run there, and
   its edit turn is unconfirmed.
8. **Safari proper and desktop Safari are untested.** The phone was Brave on iOS (WebKit);
   the simulator was Safari 18.3.
9. **The cost of `Vary: *`**: no answer of a guest's dev server is reused from the HTTP
   cache in any browser. Not measured.
10. **Two upstream bug candidates**, each with a page that needs no runtime:
    the JavaScriptCore crash of a shared-memory grow against worker teardown
    (`runtime/harness/webkit/grow-crash/`, phone build `probes/grow-crash.html`; webkit
    report 9.1), and WebKit running an earlier document's preloaded module without a
    request (`runtime/harness/webkit/preload-reuse/run.ts`, `probes/preload-reuse.html`;
    webkit report 10). Neither is reported.
11. **Whether `examples/todo-fullstack` stays in the repository.** It is the test target
    the memory figures were taken on; it has no root script.

Smaller things seen in this pass: the collector address in the phone build
(`https://diesel2…:4319/diag`) answers only while `tailscale serve --https=4319` runs on
diesel2, and it was not running, so the panel said "send FAILED"; Chrome's tab crashed once
when the page was navigated away 6 s into a boot (load 25), not again in eight further
loads; the terminal scenario's `warm` step failed once on a new origin while the page
reloaded itself for isolation, as in webkit-try section 4.

## 5. Building in a worktree

`examples/terminal-app` needs two things a fresh worktree does not have: the OpenCode
2.0.26 server (`.runtime/opencode-2.0.26/`, which `bun run terminal` builds from
`ports/opencode/server`) and the client for Node (`ports/opencode/dist/node/`, which needs
the gitignored `ports/opencode/vendor/` checkouts and a native build). Both were
copied here from the `browser-agent-toolkit-pty` worktree, whose `ports/opencode` is the
same as this branch's; then `bun run setup`, `bun run display`, `bun run prepare:editor`
ran unmodified. The server bundle has its build directory's path in it (eight `__dirname`
strings), so a bundle built here differs from the copied one in those strings alone and
would give the image another hash, and every browser that has the image a 37 MB download.
That is the reason for copying rather than rebuilding.

## 6. Reports

- [`2026-10-11-webkit.md`](2026-10-11-webkit.md): the runtime in WebKit, fix by fix; the crash (9.1); the preload reuse (10).
- [`2026-10-11-webkit-perf.md`](2026-10-11-webkit-perf.md): start-up time.
- [`2026-10-11-memory-footprint.md`](2026-10-11-memory-footprint.md): what the tab costs in Chrome; iOS limits with sources.
- [`2026-10-11-memory-reduction.md`](2026-10-11-memory-reduction.md): the reductions; WebKit's memory (7); what to read on a real iPhone (10).
- [`2026-10-11-webkit-try.md`](2026-10-11-webkit-try.md): the phone build, the first try on an iPhone (7), models on the phone (6).
- `docs/design/decisions.md`: the entries of 2026-10-11 (exclusive handles, fixed kernel memory, `Vary`, bodies over a port).
