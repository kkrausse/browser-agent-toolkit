# Memory reductions after the footprint report (2026-10-11)

Branch `ios-memory` (from `webkit-perf`, with `measure/memory-footprint` and, at the end,
`origin/main` merged in). Continues `2026-10-11-memory-footprint.md`. The pass was closed
before its last round of measurements; section 9 says exactly what was and was not run.

**"WebKit" here is Playwright's Linux build (`webkit-2370`), not Safari.** Chrome is 154,
headed on Xvfb through `browser-control`; the memory-infra dumps come from a headless
Chrome launched for the purpose. diesel2 was shared and busy throughout: 1-minute load 2.2
to 17, given with each table. Scripted model only; no model conversation was paid for.

## 1. Result

All "before/after" figures below are on the **full-stack TODO example** (React Router,
tRPC: the app the footprint report measured, now `examples/todo-fullstack`) and on the
terminal example as it was before the merge of `main`. MB, median (min–max).

| Chrome, full-stack TODO, reopen, renderer PSS + swap | before (n = 2) | items 1–3 (n = 2) | all changes (n = 2) |
| --- | --- | --- | --- |
| open, 10 s after ready | 467 (462–472) | 331 (330–332) | 301 (287–314) |
| open, after forced collection | 310 (308–312) | 312 (311–314) | 270 (266–274) |
| after six turns, 120 s idle | **348** (348–348) | 351 (348–355) | **304** (303–305) |
| … after forced collection | 344 (343–344) | 347 (343–350) | 299 (298–300) |
| editor exited, after forced collection | **116** (116–117) | 63 (61–64) | **62** (61–63) |
| highest resident size in the run (VmHWM) | 608 (602–613) | 567 (561–573) | 539 (519–559) |
| kernel memory: committed / resident at idle | 73 (66–80) / 53 | 256 / 56 | 256 / **44** |
| `partition_alloc` at idle | 146 | 147 | **110** |

- **Idle: 348 → 304 MB (−44, 13 %).** 36 MB of it is script source text now kept one byte
  a character (section 6), 10 MB the kernel memory's high-water mark (section 3).
- **A page that stays open after Exit: 116 → 62 MB** (item 3).
- **First open**: the fix is in (item 4) but its after-measurement was cut short; see
  section 5 for the cause, which was measured.
- The kernel memory is created at a fixed 256 MiB and never grown (item 1). That costs
  nothing resident in Chrome or in Linux WebKit; what it buys on iOS (4 GiB less
  reserved, no shared-memory grow) could not be run here.
- **Linux WebKit needs far more than Chrome for the same tab: about 0.9 GB at open,
  0.9–1.3 GB idle, peaks of 1.5–2.1 GB during turns, 2.6 GB on a first open** (section 7).
  Everything in the footprint report's judgement of fit assumed WebKit needs what Chrome
  does. In this port it does not.
- Not clean: with the new kernel the WebKit peak during turns is higher than before
  (2.06–2.14 GB against 1.49–1.56 GB) while its idle is lower. Not explained (section 7).

## 2. How it was measured

```sh
bun run setup                      # then prepare + build each example
bench/memory/serve.sh              # servers; ports by TODO_PORT, MOCK_PORT, TERM_PORT, FULL_PORT, FULL_MOCK_PORT
bun bench/memory/run.ts --example todo --kind reopen|first --runs 2 --idle 120 --label x [--cache B] [--kmem P] [--kmax P]
bun bench/memory/run.ts --browser webkit --example todo --runs 2 --idle 60 --label wk-x
bun bench/memory/compare.ts bench/memory/out/a.json bench/memory/out/b.json
bun bench/memory/infra.ts --example todo|terminal [--snapshot /app/server.js]   # own Chrome, memory-infra
bun runtime/harness/webkit/probe-sharedmem.ts ; bun runtime/harness/webkit/probe-modules.ts
```

- Same points as the footprint report. New in the driver: the kernel's own counters at each
  point (`bat-memory-stats` in localStorage makes the runtime expose them), a timeline of
  the renderer by kind of mapping while the editor opens, and a WebKit mode: the web
  process is found under the driver's process tree by the same CPU pattern and read from
  `/proc`. WebKit has no forced collection, so its "idle" is whatever the collector left.
- "Before" is commit `5265b43` (the branch as cut). For start-up A/B the baseline runtime
  was built from an archive of that commit and served beside the new one.
- Result files: `bench/memory/out/base-*` (before), `s123-*` (items 1–3), `s5-*` (all
  changes), `wk-*` (WebKit), `infra-*` (memory-infra), `bench/startup/out/mem-*`.

## 3. Item 1: the kernel memory (`9b05259`, `1214e7c`, `d87c5a6`; decision entry `da0fc87`)

Design and options: `docs/design/decisions.md`, "the kernel memory has a fixed size".

- `new WebAssembly.Memory({ initial: 4096, maximum: 4096, shared: true })`: 256 MiB, never
  grown. Configurable: `kernelMemory: { pages, maximumPages }` on the runtime's boot
  options, in the toolkit's `BootOptions`, and as `openEditor({ runtime: { … } })`.
- The allocator hands out address space from a break starting at `__heap_base`; it calls
  `memory.grow` only for an embedder that asks for a growable memory (64 MiB steps, the
  mitigation of `7f8bf72` on `webkit-support`, which this supersedes in `alloc.rs`).
- wasi-libc's `malloc` was linked into the kernel and lives on `memory.grow`; the crate now
  defines the C allocation functions over the kernel heap.

Measured:

| | |
| --- | --- |
| Linux WebKit, shared memory `initial = maximum = 256 MiB`, not written | made in 0.06 ms, +0.4 MiB resident; writing 32 MiB of it: +32 MiB |
| … shared memory grown by 64 MiB under its maximum | 0.02–0.04 ms, +0.2–0.7 MiB |
| … unshared memory (one of twelve) grown by 32 MiB, not written | 2.4 ms, +0 MiB: the SQLite pre-reservation of `797c8fd` is not resident there |
| Chrome, kernel memory 256 MiB committed | 35 MB resident at open, 44–56 after turns: only touched pages |
| Chrome, SQLite memory of the OpenCode worker | 34.3 MB committed, 12.1 resident |
| WebKit address space | did not move for any declaration, 4 GiB included: this port reserves its cage whole at start (72 GB), so iOS's reservation limit cannot be seen here |

Kernel bytes in use (the kernel's counter), peak in a session of six turns: **full-stack
TODO 43–54 MB, terminal 63 MB**; in WebKit 43–56 MB. 256 MiB is four times the larger.

Why the old memory grew from 42 to 82 MB during a session: not the image cache, as the
footprint report inferred (it holds 8 MB after 60 chunk loads in the TODO example, 16 MB in
the terminal example). The heap's end jumped from 38 to 72–78 MB with never more than 54 MB
in use: the buffer of an overlay snapshot, grown by doubling. It is now allocated at its
final size (`d87c5a6`): heap end 46–47 MB, kernel memory resident 53–56 → 44 MB.

Exhaustion (`bench/memory/fill-memory.cjs` in a 64 MiB memory, Chrome and WebKit): a guest
writing a file gets `ENOSPC: no space left on device` after 20–24 MiB, the kernel logs one
line with the sizes and the option, and the same process and the next one carry on. Not a
trap. Two limits to know: a file is one contiguous buffer that grows by half, so the
largest single file is about a third of the free memory; and the many small allocations
still abort if the reserve (1/16, at most 16 MiB) is exhausted too.

Also seen: a process's 1 MiB stack is freed 5 s after it exits, so a burst of spawns holds
that much for a while (the harness's `shell.cjs` reaches 107 MB in WebKit, 46 MB settled).

## 4. Item 2: image chunk cache (`9b05259`)

Limit 32 MiB over all images, second-chance clock, readers pin a chunk for their copy;
`imageCacheBytes` on the boot options. Decision entry with the sweep: "the image chunk
cache has a limit". Re-reading a dropped chunk costs about 0.02 ms in Chrome and 0.05 ms
in WebKit (through kerneld); a guest reading 98 MB of image files three times ran at
92–135 ms per pass at 32 MiB against 70–104 ms with no limit, in both browsers (n = 2).

**In neither example does the limit bind** (8 and 16 MB cached, 0 chunks dropped), so it
saves nothing there. It removes the worst case: a guest that reads the dependency tree
(`rg` over `node_modules`) held up to 240 MB, which a fixed memory would not survive.

## 5. Items 3 and 4

**Item 3, memory released after Exit (`1214e7c`).** The page kept the memory through
listeners on `window`, the caller's signal and the service-worker registration, and
through the application's own reference to the closed runtime. The listeners now go with
the runtime and the page's kernel binding drops the memory, its views and the instance
(`Kernel.release`); `codec.ts` read `kernel.x` once and kept it. After Exit and a
collection the renderer has 62 MB (116 before); `Runtime.queryObjects` finds no
`WebAssembly.Memory`. Reopen in the same page: the bench reopens in a new tab, so a
reopen after Exit in the same document was **not** re-run after this change.

**Item 4, first-open peak (`b1d33c5`).** Cause, measured before the change: on a first open
the renderer peaks at 875 MB at 3.4 s; against a reopen the excess is in `partition_alloc`
(+135 MB, of which the `array_buffer` partition is 80 MB at the "open" point and 0 at idle)
and in the V8 sandbox outside the Wasm memories (+100 MB); `bat-netd` alone held 21 MB of
ArrayBuffer backing stores ten seconds after the open. The download made a new 1 MiB
buffer per block and the stream a new chunk per read: 480 MB of buffers that only a
collection frees. Now blocks are reused and, where the body is a byte stream, read in
place (BYOB). **After-figures in Chrome: not taken** (the run was stopped at its first
point). One WebKit first open with the change: 2,160 MB at open, VmHWM 2,586 MB, so in
WebKit the first-open peak is not bounded by this; no WebKit "before" exists for it.

## 6. Steady state: what is in `partition_alloc`, and the OpenCode worker

From memory-infra dumps and a V8 heap snapshot (`bench/memory/infra.ts`; a headless Chrome
with a fresh profile, so each is a first open, 30 s idle after two turns):

| full-stack TODO, renderer at idle | before | all changes |
| --- | --- | --- |
| PSS + swap | 379 | 345 |
| `partition_alloc`, `buffer` partition | 123.8 | 86.6 |
| `malloc` | 56.6 | 64.6 |
| V8 (workers / page) | 74.8 / 12.3 | 75.5 / 12.4 |

- The `buffer` partition is where Blink keeps script source text. The heap snapshot of the
  OpenCode worker names it: **52.6 MB of `ExternalStringData` for the 27.6 MB OpenCode
  program script**, two bytes a character because 99,341 of its characters are above
  U+00FF. `d06033b` writes such characters as `\uXXXX` where that cannot change the program
  (strings, untagged templates, regular expressions, comments): 26.8 MB afterwards, and the
  same halving for the Vite start-up program (6.8 MB) and the runtime's worker bundles.
  Both examples end with no wide character left.
- About 45 MB of `buffer` is **not identified**. `malloc` (57–65 MB) was not broken down.
- OpenCode worker, other large things: its SQLite memory (34.3 MB committed, 12 resident),
  a tree-sitter memory (11.3 MB), a 7 MB string that is OpenCode's own model catalog, a
  3.1 MB buffer. The "27.5 MB of buffers" CDP reports for it was **not resolved** into
  owners: `Runtime.queryObjects` returned no ArrayBuffers in worker contexts, and the
  snapshot shows no single JS buffer of that size.
- Terminal example at idle in the same set-up (all changes, one run): 555 MB, of which V8
  170 (workers 149), `partition_alloc` 109, `malloc` 105. No "before" dump was taken.

Irreducible from the runtime, by these dumps: V8's heaps and code (about 90 MB in the TODO
example, 170 in the terminal one), the source text of the programs at one byte a
character (about 35 MB), OpenCode's own heap and catalog. No idle target was set against
a measured floor; the result is 348 → 304 MB on the full-stack app.

## 7. WebKit

Web process PSS + swap, full-stack TODO, reopen; the browser's other processes add
110–140 MB.

| | n | open | after six turns | 60 s idle | exited | VmHWM |
| --- | --- | --- | --- | --- | --- | --- |
| before | 4 | 814–896 | 937–1,370 | 942–1,327 | 357–404 | 1,494–1,559 |
| items 1–3, 256 MiB | 2 | 896–902 | 1,310–1,821 | 933–1,169 | 300–337 | 2,121–2,135 |
| … 96 MiB (`--kmem 1536`) | 2 | 898–900 | 1,257–1,300 | 913–1,031 | 342–366 | 2,073–2,086 |
| … growable from 4 MiB, 64 MiB steps | 2 | 885–886 | 1,052–1,213 | 862–994 | 331–361 | 1,891–2,056 |
| baseline JS, new kernel | 2 | 886–899 | 1,276–1,667 | 966–1,194 | 373–381 | 1,998–2,048 |
| … built to grow 1 MiB at a time | 2 | 828–900 | 963–1,148 | 918 | 354–355 | 1,871–1,926 |
| … with the baseline's image cache code | 2 | 879–914 | 887–1,089 | 825–845 | 314–376 | 1,231 and 1,859 |
| all changes | 3 | 903–948 | 1,290–1,589 | 856–959 | 302–351 | 2,064–2,141 |

- The size of the kernel memory, fixed against growable, and the grow step do not move
  these numbers: the rows for 96 MiB, 256 MiB and the growable memory agree.
- **The peak during turns is higher with the new kernel module in 13 of 15 runs** and was
  never above 1,560 in the 4 baseline runs. It falls back without anything being done, so
  it is uncollected garbage, but what in the kernel changes when JavaScriptCore collects
  was not found; the bisection stopped at a variant that gave one low and one high run.
  Treat it as an open regression of the transient peak in this port.
- Per-worker Wasm modules (item 5, measured, not fixed): 8 workers that each compile the
  four runtime modules (4.0 MB of Wasm) cost 255–258 MB against 90 MB for 8 empty
  workers and 118–121 MB when the modules are compiled once and posted: **about 21 MB
  per process worker, 17 MB of it avoidable** (n = 2). Chrome shares the code.
- Narrow script text made no visible difference in WebKit at "open".
- Harness in WebKit: 12/12 with items 1–3; **not re-run on the final head**.

## 8. Start-up and harness

`bench/startup/run.ts`, baseline runtime against the new one, interleaved; whole open, ms:

| | baseline | new |
| --- | --- | --- |
| Chrome, reopen, items 1–3 (n = 8, load 8.1) | 1,630 (1,442–2,318) | 1,647 (1,514–2,001) |
| Chrome, reopen, all changes, first run (n = 10, load 6.1) | 1,351 (1,296–1,511) | 1,460 (1,375–1,946) |
| Chrome, reopen, all changes, second run (n = 9, load 7.7–8) | 1,432 (1,350–1,666) | 1,295 (1,197–1,653) |
| Chrome, first open (n = 4, load 5.1) | 1,653 (1,596–2,484) | 1,978 (1,534–2,636) |
| WebKit, reopen (n = 8, load 9.4) | 2,282 (2,196–2,335) | 2,195 (2,079–2,517) |
| WebKit, first open (n = 3, load 8) | 3,017 (2,611–3,048) | 2,848 (2,439–2,851) |

The two Chrome runs of "all changes" disagree in sign (+109 ms, then −137 ms). The first
followed directly on new program-script files, for which Chrome had no code cache yet;
that reading is an inference. No regression is established, and none is excluded below
about 100 ms. Chrome's first open is slower in the median with wide, overlapping ranges.

Harness: 12/12 in Chrome and WebKit with items 1–3; on the stage with all changes 11/12
in both because the merged `babel.cjs` guest needs the plain app's image; **12/12 in
Chrome on the final merged head** with that image. WebKit not re-run there.

## 9. Measured, inferred, not done

- **Measured**: every figure in the tables; the probes; the exhaustion check; the
  heap snapshot. Run counts are in the tables; most cells are n = 2.
- **Inferred**: that untouched committed pages are free on iOS (true in both engines
  here); that 256 MiB can be reserved on the old 2 GB cage; the code-cache reading of the
  start-up runs.
- **Not done**:
  - After `origin/main` was merged, **no memory measurement** was taken: nothing on the
    plain TODO example, nothing on `examples/todo-fullstack` under its new name, nothing
    on the terminal example with the plain app inside. The full-stack example and the
    plain one are prepared and built on the merged head; only the Chrome harness ran.
  - Terminal example: "before" (n = 2) and items 1–3 (n = 2) exist; **no run with all
    changes**. Its idle figures are without a forced collection and differ by more than
    the changes could explain (538 before, 655 at 256 MiB, 567 at 96 MiB), so no terminal
    before/after is claimed.
  - First open in Chrome after item 4; a WebKit baseline for the first open.
  - A reopen after Exit in the same document after item 3.
  - The 45 MB of `buffer` and all of `malloc`; the owners of OpenCode's 27.5 MB.
  - The cause of the higher WebKit peak.
  - Item 5's fix (compile the runtime modules once and post them).

## 10. For a real iPhone

1. Does it start at all: a 256 MiB shared memory on iOS 17 and older (2 GB cage) and on
   current iOS; if not, `kernelMemory.pages` is the knob and peak use is 43–63 MB.
2. The WebContent footprint at open, after turns and idle, read in Xcode or from a jetsam
   log, to replace section 7: Linux WebKit says 0.9–2.1 GB, which is over a 1.5 GB limit
   at its peaks. Whether Safari's memory-pressure handling collects what this port leaves
   lying is the question those peaks turn on.
3. Whether committed, never-written pages of the 256 MiB count against the limit.
4. The first open (2.6 GB VmHWM here in WebKit).
5. Per-worker module cost in Safari, before building the fix.
6. That `Response.body.getReader({ mode: 'byob' })` works there, or the fallback runs.
