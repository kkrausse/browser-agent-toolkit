# WebKit start-up time (2026-10-11)

Branch `webkit-perf`, cut from `webkit-support` at `64b8954`. Continues
`2026-10-11-webkit.md`, section 8 items 3 and 4: why a reopen takes longer in WebKit than in
Chrome, and the first open waiting for the whole image.

**"WebKit" is Playwright's Linux build (`webkit-2370`, WebKit 27.2), headless, persistent
profile. It is not Safari.** Section 7 says what should carry over. Chrome is 154, headed on
Xvfb through `browser-control`. Everything is served from localhost. The machine was shared
and busy the whole time (1-minute load 3 to 16); every number has its load beside it, and
before/after comparisons were sampled alternately from two servers so both sides saw the
same load.

## 1. Result

| TODO example, click → app visible and chat ready | before | after |
| --- | --- | --- |
| WebKit, reopen (n = 10 each, load 5.3–6.8) | 2,786 ms (2,605–3,254) | 2,015 ms (1,859–2,772) |
| Chrome, reopen (n = 12 each, load 7.8–10.3) | 1,540 ms (1,411–1,807) | 1,470 ms (1,409–2,241) |
| WebKit, first open (n = 6 each, load 7.6–10.7) | 4,221 ms (3,880–4,764) | 2,702 ms (2,462–3,237) |
| Chrome, first open (n = 22 each over three runs, load 6.0–13.7) | 1,778 ms (1,655–2,448) | 1,837 ms (1,634–2,528) |

Median (range). "Before" is `64b8954`, "after" is `bebd975`. WebKit's reopen went from 1.81
to 1.37 times Chrome's.

Two causes accounted for the time in OpenCode's start, and neither was a wait, a poll or
file I/O:

1. **About one second: `memory.grow`.** SQLite's C allocator grows its Wasm heap 64 KiB at a
   time, and in this WebKit each grow of that memory copies the whole memory.
2. **About half a second: JavaScriptCore parsing OpenCode's 27 MB module function twice.**

Both are fixed. The first open no longer waits for the image. What is left of the gap is
in section 6.

## 2. How it was measured

```sh
# two built copies of the tree, served side by side (base = 64b8954, new = the branch)
bun bench/startup/run.ts --label x --browser webkit --variants base=4474,new=4475 --reopen 10 --trace
bun bench/startup/run.ts --label y --session <own session> --variants base=4474,new=4475 --reopen 12 --prime 3 --trace
bun bench/startup/phases.ts bench/startup/out/x.json new      # medians per phase from the trace marks
```

- `bench/startup/run.ts` got `--browser webkit`: the same sample code, run against a
  Playwright WebKit of the process, one browser and profile per variant. (Two variants in
  one profile failed with "Failed to write to file": ports of one host are one site to
  WebKit and the second copy of the image hit its storage limit.)
- `bench/startup/phases.ts` turns the trace marks into the phases used below.
- The scripted model (`examples/terminal-app/mock-model.ts`) stood in for the provider. No
  model conversation was paid for.
- **A profiler for the guest.** The web process of Playwright's WebKit reads JavaScriptCore
  options from the environment, so
  `JSC_useSamplingProfiler=true JSC_samplingProfilerPath=/tmp/dir/ JSC_sampleInterval=500 JSC_samplingProfilerTopFunctionsCount=30`
  in front of the bench writes one file per thread when the thread ends, with samples per
  function and per tier. `JSC_logGC=1` with `DEBUG=pw:browser*` prints collections. `perf`
  is not usable on this machine (`perf_event_paranoid` 4).

Samples: `bench/startup/out/webkit-perf-*.json` (the two reopen files keep their traces).

## 3. Where OpenCode's start went

Phases of the OpenCode process, reopen, medians. WebKit n = 10 each, Chrome n = 12 each, from
the interleaved runs of section 1.

| | WebKit before | WebKit after | Chrome before | Chrome after |
| --- | --- | --- | --- | --- |
| program script loaded (`import()` in the spare worker) | 563 | 702 | 527 | 489 |
| loaded → entry returned | **501** | 59 | 10 | 10 |
| entry returned → listening on 4096 | 320 | 469 | 254 | 243 |
| listening → first health request | 108 | 169 | 70 | 88 |
| `await-activation` request → response | **1,108** | 499 | 438 | 417 |
| spawn → listening | 1,401 | 1,252 | 768 | 737 |
| listening → ready | 1,242 | 698 | 566 | 559 |

The earlier report's "1.4–2.4 s between listening and ready against 0.43 s" is the last row.

### 3.1 `await-activation`: the SQLite heap

Evidence, in the order it was found:

- A 5 ms `setInterval` inside the worker did not fire for 1.9–2.4 s while the event loop ran
  only 5 turns, and the kernel calls of that time added up to 2 ms (1,502 `pread`s). So the
  thread was running, not waiting, and not in the kernel.
- The sampling profiler put 2,038 of that worker's 4,623 samples (about 1.0 s) in
  `.wasm-function[1356]` of an unnamed module, tier BBQ. Only `sqlite3.wasm` has a function
  1356 of that shape: 71 bytes, `memory.size` / `memory.grow`, which is wasi-libc's `sbrk`.
- The memory of that module went from 4.0 MiB to 13.8 MiB during the start: 146 grows of
  one page. On a first open, where OpenCode creates its database, to 26.3 MiB: 337 grows,
  and 2,193 samples in the same function.
- `runtime/harness/webkit/probe-memgrow.ts`: a grow is cheap for a memory that grows in
  place (0.02 ms) and JavaScriptCore gives that kind only to the first few memories of a
  process. With 8 other memories alive, one grow of a 4 / 16 / 64 MiB memory took 2.4 / 8.7 /
  36 ms: about 0.5 ms per MiB, a copy. A tab of this runtime holds a dozen memories before
  OpenCode opens its database. Chrome: 0.1 ms for 64 grows at any size.

Fix (`797c8fd`, `51086e6`, `runtime/src/sqlite/engine.ts`): the engine allocates and frees one
32 MiB block when it is instantiated. wasi-libc's allocator cannot return memory, so the
block stays with it and the start needs no further grow; whenever the engine later finds
that the allocator grew by itself, it does the same again with the size of the memory. The
pages are not touched. Tried first and dropped: growing the memory from JavaScript before
the first `malloc` (the allocator did not adopt it, and the grows got dearer: 1,116 → 1,526
ms), and 16 MiB (enough for a reopen, not for a first open, because the allocator's own
growth is only noticed between calls).

### 3.2 Loaded → entry returned: the module function parsed twice

- Marks around the three steps of linking the module showed the 0.45 s in the call of the
  module function, before any of its code ran.
- Outside the runtime, with the same program script
  (a throwaway page; the numbers are in the commit message of `f500cf1`): the first call takes
  21–26 ms right after `import()`, the same after a 300 ms idle wait, and 260–500 ms after
  64 MB of allocation. With `JSC_logGC=1` the only collection between load and call in that
  case was an Eden collection.
- `JSC_useSourceProviderCache=false` made every phase 350–500 ms slower (n = 3, at a higher
  load than its control, so only the direction counts).

Reading: JavaScriptCore checks a function's syntax when the script is loaded and parses it
again at its first call, skipping nested functions by offsets it remembered; a collection
drops those, and the 27 MB are lexed again. The mechanism is inferred from those three
observations and from memory of the engine's source, not read in the source.

Calling the function early was not enough: a generator's body is compiled at its first
`next()`, and the 0.45 s moved there. Fix (`f500cf1`): the header of an ES module in a
program script begins with `if(__bat===void 0)__bat=yield;` and the module is registered with
a third argument; the loader starts such a function when the script is loaded ahead of its
use and resumes it with the module's context when it links it. Design entry in
`docs/design/decisions.md`, format in `docs/design/image-format.md`.

The gain is smaller than the 0.44 s the row shows: loading now includes the start (+0.14 s),
and the code that runs next is 0.15 s slower, presumably because the second parse used to
leave the offsets fresh for it. Net, spawn → listening fell by 0.15 s.

### 3.3 What was suspected and is not it

- A remaining timed `Atomics.waitAsync`, a polling interval: none found in this path.
- Reads through kerneld: 1,502 reads, 2 ms.
- The catalog refresh: in these runs the guest's first outside requests came after the
  1.2 s, and each took 8–16 ms.

## 4. First open: the image is mounted while it arrives

Probe first (`runtime/harness/webkit/probe-getfile.ts`), while another worker holds the
file's only sync access handle and appends: a fresh `getFile()` sees what was written,
flushed or not; a File keeps its size, and reading it fails with `NotFoundError` once the
file was written to again; 0.3 ms per `getFile()`, 1.6 ms per 128 KiB read.

Built (`bebd975`; design entry in `decisions.md`): `image.ts` announces the partial file once
its head is written also where handles are not shared but `FileReaderSync` exists. kerneld
mounts it without a handle and serves the kernel's synchronous read from a stash: the head
before the mount, and per fault 1 MiB read from a fresh snapshot. What has not arrived is a
short read, which the kernel already turns into a wait for the download's progress. When
the download ends the host has kerneld open the file before it tells the kernel. Chrome has
shared handles and never takes the branch.

WebKit, first open, storage emptied, interleaved, n = 6 each, load 7.6–10.7. "No snapshots"
is the new tree with only this change switched off.

| ms after the click | before (`64b8954`) | no snapshots | after |
| --- | --- | --- | --- |
| booted and mounted | 1,052 (1,008–1,283) | 1,088 (1,026–1,184) | 280 (237–830) |
| app visible | 2,544 (2,296–3,081) | 3,624 (2,416–4,367) | 2,225 (1,832–2,689) |
| agent ready | 4,129 (3,796–4,708) | 2,682 (2,016–2,815) | 2,623 (2,393–3,154) |
| app visible and chat ready | 4,221 (3,880–4,764) | 3,624 (2,416–4,367) | 2,702 (2,462–3,237) |

- The mount comes 0.8 s earlier and the app 0.3 s earlier than before.
- The agent does not get ready sooner for it: its start is bound by its 27 MB program
  script and by the processor, not by the image. The 1.5 s the agent gained on a first open
  is the SQLite heap (337 grows).
- From localhost the 239 MB arrive in about a second. On a real link the wait this removes
  is the download time; that is expected, not measured (no throttled run).
- In the "no snapshots" column the app became visible 1.3–2 s late in 4 of 6 samples: the
  browser asked the preview for nothing for about a second after `/@vite/client`. Not seen in
  the other two columns (0 of 6 each) and not explained. It is a variant that does not ship.

Chrome, first open, base against new: 1,776 against 2,027 ms (n = 6, base sampled first),
1,778 against 1,799 (n = 8, new first), 1,925 against 1,739 (n = 8, base first). Pooled
1,778 (1,655–2,448) against 1,837 (1,634–2,528), n = 22 each. No direction.

## 5. Checks

- `runtime/harness/check.sh`: 12 of 12 in Chrome and in WebKit after each of the three
  runtime changes (4 runs each browser).
- README scenario in WebKit with the scripted model (`demo/webkit.ts --runs 3`, at the end):
  3 of 3; first-ever open 2.9 s, reopens after the workspace reset 2.7 s and 2.5 s (the
  earlier report: 5.8 s, and 4.0–4.3 s). Load 7.
- Not run: the scenario in Chrome with a model, Safari, a phone, a throttled network.

## 6. What is left between the two browsers

WebKit after against Chrome after, reopen, from section 3:

| | WebKit | Chrome | ratio |
| --- | --- | --- | --- |
| click → booted | 65 | 113 | 0.6 |
| Vite spawn → listening | 638 | 564 | 1.1 |
| Vite listening → first response | 505 | 436 | 1.2 |
| first response → app visible | 210 | 340 | 0.6 |
| OpenCode program script loaded | 702 | 489 | 1.4 |
| OpenCode entry returned → listening | 469 | 243 | **1.9** |
| OpenCode listening → first health request | 169 | 88 | **1.9** |
| `await-activation` | 499 | 417 | 1.2 |
| whole open | 2,015 | 1,470 | 1.37 |

Nothing in boot, Vite's start or app-visible is over 1.5 times. The two rows that are, 0.3 s
together, are OpenCode running its own start-up code for the first time. Not profiled
further. The likely cause is the second parse of section 3.2 one level down: the bundle has
about 2,400 module wrappers inside the one function, each parsed again when first called
after a collection, where Chrome has the compiled code in its cache. If so, the remedy is
in how prepare emits the bundle (wrappers as separate top-level functions), not in the
runtime.

Also seen, not pursued:

- Every unshared Wasm memory in a guest has the grow cost of 3.1 (the Rust modules'
  allocators also grow by 64 KiB). None shows in a start-up profile: the Vite worker's
  largest Wasm function had 29 of 2,167 samples. A guest that builds a large heap in one of
  them would. The kernel's memory is shared and does not move.
- In a profile that has never opened the page, the main thread was blocked for 0.8 s
  starting 0.15 s after the click (one observation; no block over 60 ms in three reopens).

## 7. What should hold on Safari and iOS

- **Parsing twice** is JavaScriptCore's own design, not the port's. Expected to hold, with
  other magnitudes.
- **Grow copying the memory**: JavaScriptCore's too, but which memories grow in place
  depends on the platform's address space. Expected to be the same or worse on iOS;
  unknown on macOS. The fix costs nothing where it is not needed.
- **Snapshots of a file whose handle is held**: the storage code is shared between ports;
  expected to hold, and the first thing to re-run there is `probe-getfile.ts` (it needs only
  a served page). The read failing after a later write may be timed differently.
- **Port-specific**: every absolute number (JavaScriptCore on x86 Linux under load), the
  storage limit that broke two variants in one profile, and options read from the
  environment.

## 8. Commits and files

| Commit | What |
| --- | --- |
| `b4bf63f`, `c3e61d2` | `bench/startup/run.ts --browser webkit`; `probe-getfile.ts` |
| `f500cf1` | ES modules of a program script started at load |
| `797c8fd`, `51086e6` | SQLite heap grown in large steps; `probe-memgrow.ts` |
| `bebd975` | arriving image read through snapshots |

Outside `host/image.ts`, `kernel/kerneld.ts`, `kernel/opfs.ts` (the last is untouched):

- `runtime/src/loader/loader.ts`, `crates/bat-prepare/src/program.rs` and `startup.rs`
  (3.2). Program scripts and runtime must come from the same build, as before.
- `runtime/src/sqlite/engine.ts` (3.1).
- `runtime/src/host/host.ts` (5 lines: pass `usable.snapshot` to the mount, await
  `imageArrived`), `runtime/src/kernel/boot.ts` (carry both to kerneld).
- `bench/startup/run.ts`, new `bench/startup/phases.ts`, two new probes in
  `runtime/harness/webkit/`.
- `docs/design/decisions.md` (two entries appended), `docs/design/image-format.md`.

`decisions.md` will conflict with `webkit-support` at its end if that branch appended too;
both sides are kept.
