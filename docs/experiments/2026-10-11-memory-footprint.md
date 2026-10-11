# Memory footprint of the runtime in Chrome, and what it says about an iOS Safari tab (2026-10-11)

Branch `measure/memory-footprint` (from `main` at `fb11ec1`). Measurement and analysis only;
no runtime code was changed. Driver and result files: `bench/memory/` (`run.ts`, `report.ts`,
`serve.sh`, `todo-server.ts`, `out/*.json`). `bun bench/memory/report.ts` prints every table
below from the result files.

## Short answer

- **Steady state, TODO example, editor open and idle: about 350 MB in the tab's renderer**
  (PSS + swap, 349–352 over 4 runs), plus about 50 MB for the renderer Chrome gives the
  service worker. After six scripted turns and ten minutes alone: 379 MB. The terminal
  example: about 540 MB.
- **Peaks are what matter for a kill limit: 570 MB on a reopen, 820–920 MB on a first-ever
  open** (the dependency image is downloaded and unpacked), **940–990 MB in the terminal
  example** while the agent works.
- No single item dominates. In Chrome's own terms: non-V8 allocations (`partition_alloc`)
  145 MB, Wasm memories 78 MB resident (the shared kernel memory 57 MB of it), JS heaps and
  buffers 62 MB, V8 code and metadata 39 MB.
- The 4 GiB maximum of the kernel memory costs nothing resident in Chrome (57 MB touched of
  82 MB committed). **On iOS it is the largest risk found**: WebKit reserves a shared
  memory's whole declared maximum up front, inside a 16 GB cage that every Wasm memory and
  typed array of the process shares. That is read from WebKit's source, not measured.
- Fit: iPads with 8 GB and more, likely; recent iPhones (limit reported as 1.5–2 GB), steady
  state likely, first-open peak uncertain; 4 GB iPhones and older iPads, not established.
  **None of this was run on WebKit**, so every iOS statement is an inference, with its
  confidence given in §6.

## 1. How it was measured

- diesel2, 12 cores, 62 GB RAM, 8 GB swap that was full throughout (so swap is added to
  every process figure). Chrome 154.0.8037.97 headed on Xvfb, driven by the `browser-control`
  CLI. **The machine was never idle**: other sessions were compiling and running browsers;
  1-minute load 1.9–19.5 across the samples, given per table. The memory figures did not
  move with load (ranges below are within 2 %).
- The chat used the scripted model of the terminal example (`mock-model.ts`); no model was
  called. For the TODO example `bench/memory/todo-server.ts` is the example's server with
  its provider pointed at that mock.
- Each run uses a new tab on a hostname nothing else uses (`batmem-a.localhost`), so the
  site has a renderer of its own. That renderer is found by making the tab burn one CPU
  second, rest one, three times, and taking the only process that matches. (The first
  version took "the busiest renderer" and once picked another session's tab; those runs
  were discarded.)
- Points: **loaded** (page shown, editor not opened), **open** (10 s after "chat ready" and
  app visible), **turn1** (one turn: read and edit `src/home.tsx`, preview hot-updates),
  **turns** (five more turns, one of them the three-edit theme script), **idle** (120 s
  later, sampled every 30 s; one run 600 s), **exited** (editor closed, page still open).
- "reopen": the image is already in OPFS and the workspace was reset and opened once in a
  tab that was closed again. "first": origin storage emptied first.
- At each point: `/proc/<pid>/smaps_rollup`, `status` and full `smaps` of the renderer
  (split by Chrome's mapping names; each Wasm memory is visible as a read-write mapping in
  front of its 8 GiB reservation, so its committed and its touched size can be read
  separately); then over CDP `Runtime.getHeapUsage` for the page and every worker,
  `Runtime.queryObjects` for each context's `WebAssembly.Memory` and `Module` objects,
  `performance.measureUserAgentSpecificMemory()`, `navigator.storage.estimate()` and a walk
  of OPFS. `queryObjects` forces a collection, so each point has a "pre" sample (the tab
  left alone) and a "post" sample (the floor after collection).

Not obtained: Chrome's memory-infra dump (the relay does not deliver the trace), so
`partition_alloc` is not broken down further. `Memory.*` and `HeapProfiler.collectGarbage`
are not passed by the relay either.

## 2. Totals

MB, median (min–max). "Renderer" is the one process that hosts the page, the preview frame
and all workers. PSS + swap and private-dirty + swap differ by under 2 %, so the footprint
is almost entirely private memory.

### TODO example, reopen (n = 4, load 2.9–19.5)

| point | renderer RSS | **renderer PSS + swap** | after forced GC | peak RSS + swap since previous point | workers |
| --- | --- | --- | --- | --- | --- |
| loaded | 144 (144–144) | **35** (34–35) | 34 (33–34) | 157 (156–157) | 0 |
| open | 555 (550–561) | **430** (425–435) | 312 (311–313) | 577 (566–579) | 5 |
| turn1 | 473 (473–475) | **343** (341–345) | 319 (317–320) | 502 (497–502) | 5 |
| turns | 558 (556–565) | **427** (425–434) | 351 (350–352) | 570 (566–575) | 5 |
| idle, 120 s | 483 (482–484) | **352** (349–352) | 346 (344–348) | 525 (515–533) | 5 |
| exited | 307 (305–307) | **178** (174–178) | 121 (120–123) | 489 (487–495) | 0 |

Highest resident size of the renderer in a run (VmHWM): **567 (565–569)**.

### TODO example, first-ever open (n = 3, load 3.1–13.7)

| point | renderer RSS | **renderer PSS + swap** | after forced GC | peak RSS + swap since previous point |
| --- | --- | --- | --- | --- |
| loaded | 144 | **35** | 34 | 156 (155–158) |
| open | 689 (648–710) | **564** (524–585) | 364 (354–367) | **830 (821–911)** |
| turn1 | 526 (516–531) | **395** (388–400) | 370 (361–373) | 549 (532–550) |
| turns | 569 (514–580) | **440** (386–449) | 382 (370–383) | 582 (572–594) |
| idle, 30 s | 511 (498–513) | **382** (370–382) | 379 (369–381) | 553 (547–566) |
| exited | 311 (302–313) | **182** (174–184) | 120 (116–122) | 521 (507–521) |

VmHWM: **859 (841–917)**. The first open costs about 260–340 MB of peak over a reopen.

### Terminal example, reopen (n = 3, load 5.4–10.1; no forced collection, see §7)

| point | renderer RSS | **renderer PSS + swap** | peak RSS + swap since previous point | workers |
| --- | --- | --- | --- | --- |
| open | 575 (570–682) | **448** (443–555) | 830 (826–838) | 7 |
| turn1 | 671 (667–680) | **540** (537–548) | 698 (689–702) | 8 |
| turns | 950 (939–955) | **817** (807–823) | 961 (949–998) | 8 |
| idle, 120 s | 674 (670–687) | **541** (538–555) | 922 (748–926) | 8 |

VmHWM: **952 (941–987)**. This page boots its runtime on load, so it has no "loaded" point.

### The rest of the tab

- **Service worker.** In 6 of the 8 TODO runs it was located, each time in a renderer of
  its own (the page is cross-origin isolated, the worker's process is not): **about 50 MB
  PSS + swap (41–63)**. A page with nothing on it costs 35 MB here, so most of that is
  Chrome's price for a process. In one discarded trial run it lived in the tab's renderer
  instead. In 2 TODO runs and in the terminal runs it was not located, so those totals
  lack it.
- The browser, GPU, network and storage processes are shared by every tab and were not
  attributed.
- **Chrome's own view**: `measureUserAgentSpecificMemory()` reports 485 MB at open, 732 MB
  after the turns and **808 MB at idle (793–809)**, when the whole process has 483 MB
  resident. It counts the shared kernel memory once per context that holds it, so it is not
  usable as a total here. `performance.memory` and `Performance.getMetrics` see only the
  page: 12 MB of JS heap.

### Does it grow?

- 120 s idle, 4 runs: 351 → 352 MB, no growth.
- 600 s idle, 1 run: 354 → 379 MB, in steps (+13 MB at 180 s, +8 MB at 480 s), about
  2.5 MB/min. It is in the OpenCode server (one of its Wasm memories went from 26.4 to
  33.3 MB) and in `partition_alloc` (157 → 167). One run; whether it levels off was not
  established.
- Per turn: the kernel shared memory went from 41.8 MB committed at open to 81.7 MB after
  six turns and stayed there; it does not shrink (§4).
- After **Exit** the renderer keeps 121 MB after collection, against 34 MB before the editor
  was ever opened: the kernel memory is still held (81.7 MB committed, 57 MB resident).

## 3. Breakdown (TODO example, reopen, at idle; 352 MB)

By mapping, PSS + swap, MB:

| mapping | loaded | open | turn1 | turns | idle | exited |
| --- | --- | --- | --- | --- | --- | --- |
| `partition_alloc` (everything Chrome allocates outside V8's heap) | 12 | 180 | 147 | 154 | **145** | 35 |
| V8 sandbox: Wasm memories | 0 | 55 | 55 | 78 | **78** | 58 |
| V8 sandbox: the rest (JS heaps, ArrayBuffers) | 5 | 140 | 78 | 119 | **62** | 52 |
| `v8` outside the sandbox (machine code, metadata) | 2 | 31 | 37 | 49 | **39** | 14 |
| chrome binary (shared with every renderer) | 11 | 12 | 12 | 12 | 12 | 12 |
| pointer tables, shared-memory regions, other | 5 | 13 | 15 | 15 | 15 | 6 |

Wasm memories, from smaps (MB):

| | committed (`buffer.byteLength`) | resident (touched) | reserved address space |
| --- | --- | --- | --- |
| kernel shared memory at open | 41.8 (39.9–41.9) | 34.9 (33.4–35.3) | 8 GiB |
| kernel shared memory after the turns | **81.7** (79.7–81.7) | **57.5** (56.2–58.3) | 8 GiB |
| … first-ever open | 69.3 (64.6–82.8) | 55.9 (48.2–58.4) | 8 GiB |
| the 11 other memories (8 in Vite's process, 3 in the OpenCode server's) | 53.8 | 20.5 | 8 GiB each |
| terminal example at idle: kernel / 17 others | 83.1 / 151.8 | 71.2 / 41.1 | 8 GiB each |

The kernel memory is at **2 % of its 4 GiB maximum** (81.7 MB of 4,096). Chrome reserves
8 GiB of address space for every Wasm memory whatever its maximum, and charges only touched
pages.

Per context (CDP), MB:

| context | JS heap total | used | used after GC | ArrayBuffer backing stores | own Wasm memories | Wasm modules reachable |
| --- | --- | --- | --- | --- | --- | --- |
| OpenCode server (`/app/server.js`) | 48.9 | 46.6 | 44.4 | 27.5 | 3, 26.4 MB | 5 |
| Vite | 21.7 | 20.3 | 19.3 | 9.7 | 8, 27.3 MB | 11 |
| page and preview frame | 12.3 | 11.5 | 11.0 | 3.9 | 0 | 1 |
| spare process worker | 2.3 | 1.2 | 1.0 | 1.0 | 0 | 5 |
| kerneld | 1.8 | 0.5 | 0.4 | 0.0 | 0 | 1 |
| netd | 1.5 | 0.6 | 0.6 | 0.1 | 0 | 1 |
| **sum** | **88.5** | 80.7 | 76.7 | 42.2 | 11, 53.7 MB | |

Terminal example at idle: OpenCode server 59 MB heap, TUI client 30 MB, Vite 28 MB, page
17.5 MB, three small processes 2–3 MB each.

Counts: 5 dedicated workers in the TODO example (kerneld, netd, Vite, OpenCode server, one
spare), 8 in the terminal example; 27 threads in the renderer; one service worker.

Compiled Wasm: the runtime ships 5.0 MB of Wasm (kernel 0.36, `bat_modules` 1.24,
`bat_node_native` 1.15, `bat_sh` 0.95, `bat_tls` 0.65, sqlite 0.67) plus two guest shims of
1.2 MB each. The size of the compiled code is not exposed; its upper bound is the 39 MB of
`v8` mappings, which also hold all JIT-compiled JavaScript. The kernel module is compiled
once and posted to every worker. The four other runtime modules are compiled in every
process worker (`runtime/src/process/worker.ts`, `prefetchWasm`): each of the three process
workers reaches its own `Module` objects for them.

Storage: OPFS holds 238–258 MB in 5–7 files (the image is 240 MB). `storage.estimate()`
reported far more and kept rising on the same origin, 0.29 GB after the first open to
4.6 GB after about 14 opens with resets, while the files listed stayed at 250 MB. Whether
that is disk really held or Chrome's accounting was not established; clearing the three
benchmark origins afterwards returned 7.7 GB of reported usage and about 0.8 GB of disk at
once.

## 4. Which items dominate, and which look reducible

Ranked by expected saving. "Chrome" savings are read off the tables above; iOS effects are
inferred.

| # | item | what was seen | change | expected saving |
| --- | --- | --- | --- | --- |
| 1 | **Kernel memory maximum of 65,536 pages** (`runtime/src/kernel/attach.ts`) | 81.7 MB used of 4,096 | declare what is needed, e.g. 8,192–16,384 pages (512 MB–1 GiB) | Chrome: none. iOS: 3–3.5 GiB of a 16 GB cage that all Wasm memories and typed arrays share; on iOS 17 and older probably the difference between starting and not (§5) |
| 2 | **First-open peak** | 830–911 MB against 570 on a reopen | download and unpack the image in bounded pieces, outside the long-lived contexts | 260–340 MB of peak, once per origin |
| 3 | **Garbage at open and while the agent works** | open: 430 before collection, 312 after. Terminal turns: 817, then 541 | nothing direct; fewer large short-lived buffers at start-up (the 27.8 MB and 6.8 MB program scripts are fetched and compiled per worker) | up to 120 MB (TODO) and 280 MB (terminal) of peak; steady state unchanged |
| 4 | **Image chunk cache in the kernel memory** (`crates/bat-kernel/src/image.rs`; no eviction found) | 35 → 57 MB resident after six turns, never shrinks, bounded only by the 240 MB image | cap it and evict | 20–40 MB now; removes a 240 MB worst case |
| 5 | **Kernel memory kept after Exit** | 121 MB after exit against 34 before the first open | drop the memory when the editor closes | about 60–85 MB for a page that stays open |
| 6 | **Runtime modules compiled per process worker** | 4 modules × every process worker | compile once, post the `Module`, as the kernel already is | Chrome: none (V8 shares code compiled from identical bytes). JavaScriptCore: possibly several MB per worker; not measured |
| 7 | **Wasm memories larger than they are used** | 53.8 MB committed, 20.5 touched; three of 8.3 MB with 0.2 MB touched | smaller initial sizes | Chrome: none. Elsewhere only if the engine commits what is declared |
| 8 | **Spare process worker** | 2.3 MB heap, 1 MB buffers, its thread and prewarmed modules | none suggested: it buys the 3 ms spawn | under 10 MB |

Not reducible from the runtime: the OpenCode server is the largest single tenant (49 MB
heap, 27.5 MB of buffers, 26–39 MB of Wasm memory: about 100–115 MB), and
`partition_alloc`, 145 MB, the largest line, could not be broken down. About 110 MB of it
belongs to the runtime's workers (it is 35 MB after Exit); what it contains (script source,
Wasm bytes, per-thread caches, buffers) is a guess until a memory-infra dump is taken in a
Chrome launched for the purpose.

## 5. iOS limits, with sources

Apple documents no per-tab memory limit. Alexey Proskuryakov (Apple) in
[WebKit bug 268816](https://bugs.webkit.org/show_bug.cgi?id=268816), 2024-05-15: "I do not
think that this is documented by Apple." What exists is statements by WebKit engineers,
WebKit's source, and user reports.

### Per-tab (WebContent process) limit

| claim | source | kind |
| --- | --- | --- |
| "WebContent processes on iPhone are subject to a 'soft' limit of around 1.5GB"; killed by jetsam above it only under memory pressure; "somewhat lower on iPhone models with less RAM" | Simon Fraser (Apple), 2024-08-09, [bug 277848](https://bugs.webkit.org/show_bug.cgi?id=277848) | engineer's statement |
| "On iPhones, for most devices, the limit is 1.5GB"; "On iPad, the WebContent process has a higher memory limit, which differs by device"; "For an 8GB device, the limit will be in the 4GB+ range"; "unlikely that these limits will change anytime soon" | Ben Nham (Apple), 2024-03-13, [bug 268816](https://bugs.webkit.org/show_bug.cgi?id=268816) | engineer's statement |
| "iPhones do indeed have stricter jetsam limits than iPads" | Apple Frameworks Engineer, April 2026, [Apple Developer Forums 823061](https://developer.apple.com/forums/thread/823061) | staff reply; confirms direction only |
| iPhone 17 Pro (12 GB), iOS 26.3–26.4.1: WebContent killed at `ActiveHard 2048 MB (fatal)`; same page ran on iPad Pro | the poster of the same thread | one user's log |
| iOS 26: `Memory Limits: active 2048 inactive 2048` for a WebContent process, `per-process-limit` kill | [three.js forum, 2025-09-14](https://discourse.threejs.org/t/memory-limit-crash-on-ios-26/86978) | one user's log, device not named |
| iPhone 12 (4 GB): `ActiveHard 2098 MB` | [Apple Developer Forums 688973](https://developer.apple.com/forums/thread/688973) | search summary of a user report; page not read here, and it may concern an app, not WebContent |
| base threshold of 300–450 MB per page | a [blog post](https://www.catchmetrics.io/blog/deep-dive-ram-internals-webkit) | unsourced; contradicts the engineers; disregard |

Reading: **iPhone about 1.5 GB (engineers, 2024), 2,048 MB in two 2025–26 logs; lower on
low-RAM phones by an unstated amount; iPad higher, 4 GB and more on 8 GB models.** No table
by device exists in any source found. What is counted is the process's dirty and
compressed memory, not address space; iOS has no swap, it compresses.

### Wasm memory limits in WebKit

From WebKit's source on `main`, read 2026-10-11
([WasmMemory.cpp](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/wasm/WasmMemory.cpp),
[BufferMemoryHandle.h](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/runtime/BufferMemoryHandle.h),
[Gigacage.h](https://github.com/WebKit/WebKit/blob/main/Source/bmalloc/bmalloc/Gigacage.h),
[OptionsList.h](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/runtime/OptionsList.h)).
This is the code, which is a fact about `main`, not about any shipped iOS:

- A **shared** memory is always a bounds-checked memory whose whole declared maximum is
  reserved up front: `tryAllocateGrowableBoundsCheckingMemory(reservedMaximumBytes)`, with
  `reservedMaximumBytes = min(declared maximum, maxGrowableBufferReservationBytes)`.
- That reservation comes from the "Primitive Gigacage", which on the iOS family is
  **16 GB** (`hasCapacityToUseLargeGigacage` is false there; 64 GB elsewhere), and one
  buffer may reserve a quarter of it: **4 GiB**. The header says of the total across
  buffers: "Nothing bounds the total".
- Unshared memories try to be "fast memories", each a 4 GiB + 8 MiB reservation from the
  same cage, at most **3** of them on iOS (`maxNumWasmFastMemories`, 8 elsewhere); the rest
  are allocated at their current size and copied when they grow. Typed arrays and
  ArrayBuffers come from the same cage.

From the bug tracker:

- Before spring 2024 the cage was far smaller: "Currently the Gigacage supports 2GB of
  allocations on iOS" (Ben Nham, 2024-03-13, bug 268816). "We've increased the Gigacage to
  accommodate WAsm memory" (Mark Lam, 2024-05-15,
  [bug 269937](https://bugs.webkit.org/show_bug.cgi?id=269937)); fast memory on iOS landed
  2024-04-05 as 277124@main ([bug 272232](https://bugs.webkit.org/show_bug.cgi?id=272232)).
  Which iOS release first shipped these is not stated there (iOS 18 by the dates; inferred).
- [Bug 255103](https://bugs.webkit.org/show_bug.cgi?id=255103), status NEW: on iOS 16.4
  (iPhone 14 Pro Max) `new WebAssembly.Memory({initial: 3136, maximum: 32768, shared: true})`
  throws "Out of memory"; the same with `shared: false` works. A user report with no
  engineer's explanation; it is what the reservation rule above predicts for a 2 GB cage.
- [Bug 256023](https://bugs.webkit.org/show_bug.cgi?id=256023) and
  [emscripten 19374](https://github.com/emscripten-core/emscripten/issues/19374): shared
  memories not released across reloads, "Out of memory" after several reloads, on iOS 16–17.
  User reports; current status unknown.
- "WASM memory and SAB use the same small protected region" and over-allocating one makes
  the others fail (Justin Michaud, Apple, 2024-02-23, bug 269937).

What this means for the runtime, **inferred, not run**: the kernel memory's 65,536-page
maximum takes 4 GiB of the 16 GB cage the moment it is created. It is created first, so two
fast memories still fit beside it and a third does not; the remaining 12–18 Wasm memories
and every typed array share what is left (about 3.7 GB), which is enough for what was
measured here (under 0.3 GB). On iOS 17 and earlier a 4 GiB shared maximum cannot fit a
2 GB cage at all.

Storage: since Safari 17 an origin may use up to 60 % of the disk in a browser app
([WebKit, "Updates to Storage Policy"](https://webkit.org/blog/14403/updates-to-storage-policy/));
the 250 MB image is not a quota problem.

## 6. Judgement of fit

Assuming WebKit needs about what Chrome needs (the weakest assumption here; see §7), and
adding the service worker to the same budget:

| device class | limit (source quality) | steady 0.4–0.6 GB | peak 0.6–1.0 GB | judgement | confidence |
| --- | --- | --- | --- | --- | --- |
| iPad, 8 GB and more | 4 GB+ (engineer) | 10–15 % | up to 25 % | fits | moderate |
| iPhone, 8–12 GB (15 Pro and later) | 1.5 GB soft (engineers); 2,048 MB hard (two logs) | 25–40 % | 40–65 % | fits; first open and terminal turns are the tight moments | moderate for steady state, low for the peaks |
| iPhone, 6 GB | 1.5 GB soft "for most devices" | 25–40 % | 40–65 % | probably fits; the limit is enforced under pressure, and a 6 GB phone is under pressure more often | low |
| iPhone 4 GB and less, older iPads | "somewhat lower", no figure | unknown | unknown | not established; the first-open peak near 0.9 GB is the likely failure | very low |
| any device on iOS 17 or older | cage of 2 GB | – | – | probably does not start with the 4 GiB maximum | moderate (source and one bug report) |

Two things would change this table more than any saving in §4: lowering the kernel
memory's maximum (item 1), and one real run on a phone reading the WebContent process's
footprint in Xcode or a jetsam log.

## 7. What Chrome on Linux does and does not predict

**Carries over** (properties of the program, not of the browser): the number of workers,
memories and modules; each Wasm memory's committed and touched size, including the kernel's
82 MB and its growth with files read; the sizes of the buffers the programs hold; live JS
heap sizes to an order of magnitude (same scripts, same objects); the OPFS footprint; the
shape over time (large transient at open, small growth after).

**Does not carry over:**

- Everything outside the JS heaps and Wasm memories: `partition_alloc`'s 145 MB is Chrome's
  allocator, Blink and V8's side tables. WebKit's equivalents are different code.
- Compiled code. V8 compiles Wasm eagerly and shares code compiled from identical bytes
  across workers; JavaScriptCore starts in an interpreter and tiers up, and whether it
  shares modules compiled separately in each worker was not checked. Could be smaller or
  larger.
- Reservation. Chrome reserves 8 GiB per memory out of a 1 TB sandbox and none of it counts.
  WebKit on iOS reserves from a 16 GB cage (§5).
- Collection timing, and with it every peak: the 120–280 MB of garbage seen before a forced
  collection depends on V8's schedule.
- Accounting. PSS + swap on Linux is not iOS's footprint (dirty plus compressed, no swap).
- Process layout. Chrome gave the service worker its own renderer; where WebKit runs it,
  and against which budget, was not looked at.

## 8. Measured, inferred, not done

- **Measured**: every figure in §2 and §3 (11 valid runs: TODO reopen 4 + 1 long, TODO first
  3, terminal 3), the per-context heaps, the Wasm memory sizes, worker and thread counts,
  storage figures.
- **Read from source or stated by an engineer**: the WebKit rules and the limits in §5.
- **Inferred**: what `partition_alloc` contains; that the first-open peak is the image
  download and unpack (it appears only on a first open; the code path was not profiled);
  that the idle growth is the OpenCode server; every statement about what happens on iOS;
  the iOS release that first shipped the larger cage.
- **Not done**: any run in WebKit or on a device; a breakdown of `partition_alloc`; a
  machine at rest; more than one long idle run; the terminal example's first-ever open; the
  service worker's renderer in the terminal runs; the terminal example's per-context Wasm
  memories and its floor after collection.

Side findings:

- `Runtime.queryObjects` on the terminal example's page **crashed the renderer every time**
  (4 of 4; kernel log: segfault inside the chrome binary at an address 64 KiB into a
  4 GiB-aligned region). The same call on the TODO example never did (about 50 captures). Not
  investigated; the driver leaves it off for the terminal example.
- Closing the terminal example's tab while its runtime ran left its renderer alive for more
  than 150 s once; leaving the page first avoided it.
- A browser-control snippet that waits for a CDP event the relay never delivers
  (`Tracing.tracingComplete`) cannot be cancelled: the session `batmem-probe` is stuck in
  the relay with a crashed tab until the relay is restarted.
