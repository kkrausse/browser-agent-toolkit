# Repaired observer — independent focused-only visible QA

## Outcome

**PASS: one visible cohort, all original cases 0–9, all 14 original steps.**
The formerly failing observer now reaches the actual HTTP bodies. All 15 workspace
lifecycles completed public runtime stop/workspace close; all 14 post-step Chrome
censuses reached zero scoped workers inside the unchanged 15-second window. No
acceptance failure, retry, deadline increase, skipped check or production patch.
Application stages/generations rerun: **0**. Inference: **0**. Headless: **0**.

This is explicitly **focused-only**, not a new original full-suite pass or editor
acceptance. Historical `70d8c23` remains failed. Historical editor `955265d` save-busy
and kernel-retention observations are not repaired or qualified by this harness.

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-focused-observer-repaired-live-qa.md`.

## Ownership and immutable admission

- Frozen input:
  `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/focused-observer-identity-yzELv8/frozen`.
- New, previously nonexistent run copy:
  `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/focused-observer-repaired-live-20260930-once`.
- New evidence:
  `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/focused-observer-repaired-live-evidence-20260930-once`.
- One contracts host, launched once, OS port **50798**, origin
  `http://127.0.0.1:50798/`, PID **28777**, supervisor **28776**. No app/editor host.
- Driver PID **28910**, supervisor **28909**, joined stdout/stderr and exit **0**.
  Host joined stdout/stderr and exit **143** after parent-owned SIGTERM following
  successful guest acceptance, not forced guest/page failure cleanup.
- Existing visible extension-connected Browser Control **0.8.2**, Bun-backed CLI
  only; no MCP, relay change, browser installation, source-user storage or inference.
  Session list read before activation. Unchanged driver explicitly created
  `focused-identity-cases-abaf546a` before its first page operation and deleted it
  after its final log retention. Only this new session/page/origin was operated.

Before host launch, all **9,681** frozen receipt files, all **111** original candidate
outputs, and **37** native outputs checked without mismatch. Native outputs matched
both retained owner source and the verified native baseline; no native rebuild.
Frozen receipt SHA-256 remained
`0f95c698427333f8d38ac21205511b803d9e368b926b672b6461da4ad1cf4f92`.
After QA all 9,681 frozen and 9,681 run-copy receipt files reverified unchanged.
Run-copy receipt SHA-256 is
`f1b6e719cd8302ea82eae4ae1458517b433bae1961c7ea7a5581b9bdffc8c405`;
its output identity differs intentionally, not its receipted candidate bytes.

Exact runtime `33fa1359a003ca9c50cb3bc49699b99bc1a063f1`, toolkit
`d0eec346dbc749db1c0cd82dd8aad0b27c1da363`, version
`3debc8095c310192bac6062bb963e0ee09a431246cc8bafb7be2f5a1f2655a62`.
Toolkit/runtime archive hashes independently matched
`35a01cf1f209f378d44d07f49c799ba3c7b79ef54eb3cfca431ca54e9e811914` /
`a76baad09c091b03d7dbc2563dc28b781e4a14e5e7c02888e932796393f5c832`.
Retained actual OpenCode server remains actual-648, not newly exercised here.

Independent HTTP reads from the actual contracts host all returned **200**, matching:

| Served artifact | SHA-256 |
| --- | --- |
| `client/single-kernel-cases-client.js` | `59667eea1e7d56ad5c29a9451e917df0b93af9026de07dc0a8b014052a004b0a` |
| `runtime/assets/kernel-worker-5EzLFeOC.js` | `1901f5b19c06cfea796a84395a7e46d0159690c61deeba4451ffaaf672aeea7c` |
| `runtime/assets/process-worker-ZQRq3H73.js` | `ea2ac260ff11636b1aa66378eb51d629abd3ddc9b49918dd24702767b688bad7` |

## Unchanged checks and separately labelled observation

The frozen focused driver was executed once through the documented `--run-copy`,
one `serve-single-kernel.js --contracts`, and
`SINGLE_KERNEL_AUTHORIZE_RUN=yes bun "$RUN/qa/focused-observer-identity-driver-qa.js" "$RUN" "$EVIDENCE"`.
Original stage/read/interactive budgets: **120,000 / 15,000 / 60,000 ms**;
post-close census **15,000 ms**; retries **0**. All original actions/assertions and
their ordering remained unchanged. Driver independently rehashed artifacts and
archive driver sources before execution. Both focused-driver substitutions and
inherited full-client host-alias substitution independently reversed byte-for-byte.
Original complete focused-loop SHA-256:
`075d1bed181a901b9ec89c6f76315ec878881c2757460811fdd7b5803a9f624e`.

The final bundle contains exactly **one** workspace internals WeakMap. Rerunning
the actual bundled identity probe returned Workspace/Runtime/diagnoseWorkspace/
workspaceInternals reference equality **true** for all four. No observer assertion
was suppressed. Original client, cases, harness and production library were not edited.

New QA-only CLI transport:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/examples/todo-app/tests/focused-observer-repaired-live-observer-qa.ts`.
`BROWSER_CONTROL_CLI` selected this Bun pass-through; it invoked the exact installed
CLI via `FOCUSED_REAL_BROWSER_CONTROL_CLI`, joined drains/exits and returned the
original CLI stdout/stderr/status. It added a page-specific init script before first
navigation, transparently calling the original native `Worker.prototype.terminate`
with original receiver/arguments, then collected timestamps and Web Locks after
each original command. It did not change case/driver source, replay an action,
substitute a census result or change the original returned value. Its consumer
typecheck passed. All generated observation commands and the executed observer
source are retained separately. Observation adds overhead; no performance claim.

## Exact per-step completion and close evidence

Each row had **one actual `singleKernelCases.run(index,step)` initiation**, one
completed original body, original zero-work assertions, and passing close census.
`life/native` counts started+stopped lifecycle pairs / page-native terminate returns.
The OPFS case deliberately opens/closes twice inside its one body. PID counts are
the original diagnostic `nextPid - 1`, not host processes. Census IDs below are
the first **post-step** zero-worker receipts, not later cleanup observations.

| Case/step | Original body actually completed | Guest PIDs | life/native | First zero census | Native return → sampled zero ms |
| --- | --- | ---: | --- | --- | ---: |
| 0/0 | One `/never` target request; abort reason identity; accepted socket closes exactly once; natural fixture/endpoint exit | 1 | 1/1 | `0009.json` | 713 |
| 1/0 | One `/open` target request; live first bytes, reader cancel, EOF, socket closes exactly once; natural exit | 1 | 1/1 | `0020.json` | 343 |
| 2/0 | One `/large` stream; eight unread-state checks; ≤1 MiB buffering/read-ahead; exact **8,388,608** patterned bytes; backpressure/drain/finish, natural exit | 1 | 1/1 | `0032.json` | 498 |
| 3/0 | Old/new identity requests each report count **1**; **2** stale fetch forms reject CLOSED; replacement untouched; both natural exits | 2 | 1/1 | `0043.json` | 350 |
| 4/0 | Execution stop cleans child/listener and permits original port-reuse body | 4 | 1/1 | `0059.json` | 2319 |
| 5/0 | Runtime stop cleans child/listener and permits original port-reuse body | 4 | 1/1 | `0071.json` | 631 |
| 6/0 | Bulk root replacement initial persistence | 0 | 1/1 | `0082.json` | 726 |
| 6/1 | Bulk delete/recreate without stale descendants | 0 | 1/1 | `0090.json` | 710 |
| 6/2 | Original durable reopen checks | 0 | 1/1 | `0098.json` | 741 |
| 7/0 | Competing live Web Lock denied; lease bytes flushed; post-close lease acquired within original 5 s; second open verifies bytes | 0 | 2/2 | `0108.json` | 354 |
| 8/0 | Eight concurrent writes/flushes, rename/delete/truncate, final OPFS/manifest bytes before close | 0 | 1/1 | `0118.json` | 712 |
| 8/1 | Durable reopen: original rename/delete and seven final files | 0 | 1/1 | `0126.json` | 797 |
| 9/0 | SQLite owner `/ready`, same-path BUSY/independent path, acknowledged OPFS bytes, natural owner exit/release, rollback/UNIQUE/integrity/reopen | 3 | 1/1 | `0137.json` | 610 |
| 9/1 | SQLite durable count/blob reopen | 1 | 1/1 | `0146.json` | 716 |

Control `/state` polling totals and streaming chunk counts are **not separately
instrumented** by the original bodies; no invented exact totals. Target-request
counts above come from unchanged single-call bodies and their completed assertions,
not a new packet trace. There were **14** initiations/completions, **15** lifecycle
pairs/native terminate returns, and **17** assigned guest PIDs. Every stopped
diagnostic had **0** processes, listeners, pending HTTP, fetch inflight/queued/active/
cache entries/cache bytes/pinned bodies, lazy inflight and owned spawn spills.
Every post-completion sampled Web Locks query had held **[]**, pending **[]**.

Original driver retained **27** census reads: **23** successful zero-worker samples
(14 post-step + 9 inter-case), **4** transient nonzero samples at case 4/0 only
(`0055`–`0058`, two workers), followed by passing `0059` without retrying its body.
All first post-step zeros were within **343–2319 ms** of native return as conservatively
sampled after each command, within the original deadline. The page-native trace
observes kernel termination; it is not a complete trace of process-worker native
termination inside the kernel. Additive Target created/destroyed subscriptions
delivered **zero events**: no event-level destruction-time proof is claimed. The
original direct `Target.getTargets` census receipts supply actual target evidence.

## Manual evidence and auxiliary limits

Opened and visually inspected `first-completed-step-viewport.png`: native
**3780×2270** bounded viewport, no full-page capture/cropping. It shows the actual
correctness harness heading, intentionally blank iframe, `status: ready` and
original case list after first completion. Step/topology detail lies below the
viewport; this is not manual visualization of every assertion or an app/editor UI.
No prettier image or additional case was replayed; final session deletion remained
the original driver action.

Browser logs: **17** entries, dropped **0**, pageerrors **0**: one favicon 404,
15 native initialization warnings, one expected SQLite PRIMARYKEY warning from the
intentional UNIQUE-rejection fixture. Retained contract events: persistence **30**,
diagnostic **170**, topology **30**, exit **15**, stdout **3**. Exit captures include
**9** natural exit-0 and **6** intentional SIGTERM/143/forced stop-fixture exits;
the latter are original stop contracts, not failed page destruction.

Auxiliary observation TODO (Browser Control 0.8.2, owned fresh about:blank page):
`passive-0001-error.txt` retains `page.evaluate: TypeError: Cannot read properties of
undefined (reading 'query')`. Deterministic cause: the added sample calls
`navigator.locks.query()` before secure-origin navigation; about:blank lacks locks.
Expected: mark unavailable before navigation. Actual: auxiliary sample unavailable,
original command preserved. **150** later passive samples succeeded. No recovery,
retry or repair was performed during this cohort. Zero event callbacks are also an
observer-coverage limit, not substituted target evidence.

One preflight helper initially looked for the inherited QA client source in the
wrong frozen subdirectory (ENOENT); corrected read-only to its retained original
preparation source before live launch. Initial cleanup process enumeration caught
the concurrently running read-only run-copy verifier, not a leaked driver/guest;
the original receipt is preserved and final independent enumeration after its
completion is clean. Neither auxiliary correction reran acceptance.

## Cleanup and preserved limits

Normal public closes preceded every census. The driver then retained logs, deleted
its owned session and released its lock. Only afterward the exact parent-owned host
received SIGTERM; host/driver supervisors joined their drains/exits. Final independent
`ps` for all four exact PIDs and listener-only `lsof` for 50798 were empty (exit 1),
owned-process list empty, owned session absent, Browser Control targets **[]**, exact
evidence lock absent. No unrelated session/page/origin/storage/profile was reset.
**Exclusive visible Browser Control CLI slot released.**

Evidence retains 151 original numbered commands/receipts, 14 whole case receipts,
raw events/logs, passive commands/native/locks samples, original-deadline CDP target
censuses, screenshot, CLI journal, served hashes, source/provenance checks, typecheck,
host/driver PID/output/exit joins, both cleanup observations and evidence hashes.
`evidence-hashes.json` covers **645** retained files (excluding itself), SHA-256
`1fac51e6c9d6f4b7f752f7b61c9fb69f42f80537c2fa7e699cf9a377c8bbc222`.

Historical case-1 close-census failure and handshake-disposal flake remain historical
failures; this finite fresh pass does not erase them or prove flake freedom. Egress
465 minimal pass stays narrowly scoped. Full `markAsUncloneable`, lazy-loader/planted
`/bin` ancestor-symlink limitation, tampered-tree safety, all-writer quiescence,
installed-cache retention, long-lived OpenCode release and editor save-busy/kernel
retention remain unresolved/unqualified. No performance improvement is established.
Only this new report and new passive QA transport are owned repository changes;
production/original cases/master status/Effect/source investigations/pins/shared
outputs/frozen input and other staged work untouched. No push.
