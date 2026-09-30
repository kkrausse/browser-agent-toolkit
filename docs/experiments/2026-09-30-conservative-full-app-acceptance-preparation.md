# Conservative full TODO acceptance — runnable preparation, live pending

## Frozen handoff

**A complete conservative editor + original full-suite candidate is prepared. No
browser, listening host, guest, session or inference was started.** This is not an
acceptance result, cache-retention treatment, process-reuse treatment or speedup.

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-conservative-full-app-acceptance-preparation.md`.

Frozen stage:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/conservative-full-app-Yb8T8p/frozen`.

Its `receipt.json` SHA-256 is
`9b4d37a89ff57943caa45a222951ba2788a9e5980a1960c1e89e17b8c488f64b`.
All **9,677** receipt-listed files reverified, zero mismatches. Manifest includes
**12,290** managed tree entries and 34 project files, not just a partial UI bundle.
`offline:false` is the historical harness's *runnable-distribution* discriminator;
`preparationOnly:true`, `liveRuns:0`, `models:0` express the actual qualification.

Preparation runner (new owned file):
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/examples/todo-app/tests/conservative-full-app-prepare.ts`.
Current runner hash:
`550c2541eb09ed2c1454736746eedf770e919a52b829e2cd05e03216ad0de779`.

```sh
# Read-only verification; does not activate anything.
bun examples/todo-app/tests/conservative-full-app-prepare.ts --verify /private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/conservative-full-app-Yb8T8p/frozen
```

## Actual build and provenance

- Runtime `33fa1359a003ca9c50cb3bc49699b99bc1a063f1`; toolkit
  `d0eec346dbc749db1c0cd82dd8aad0b27c1da363`; version
  `3debc8095c310192bac6062bb963e0ee09a431246cc8bafb7be2f5a1f2655a62`.
  Ancestry checks passed for chat `691cd5aa` and endpoint `724909bf`.
- Fresh, exclusive toolkit/runtime git archives match the owner's archive hashes:
  toolkit `35a01cf1f209f378d44d07f49c799ba3c7b79ef54eb3cfca431ca54e9e811914`,
  runtime `a76baad09c091b03d7dbc2563dc28b781e4a14e5e7c02888e932796393f5c832`.
  Archives, isolated sources, commands and preparation inputs are retained beside
  `frozen/`; preserve this whole parent directory for the source-checking QA driver.
- All 111 owner output hashes checked before and after preparation. SDK and rebuilt
  JS workers copied unchanged from the repaired candidate, not replaced with e35.
  Kernel hash `1901f5b19c06cfea796a84395a7e46d0159690c61deeba4451ffaaf672aeea7c`;
  process-worker hash `ea2ac260ff11636b1aa66378eb51d629abd3ddc9b49918dd24702767b688bad7`.
  An unchanged process-worker hash does not imply that the changed kernel was reused.
- Native compilation was not rerun. Every native output in the owner manifest was
  rechecked both against its isolated owner source and
  `/Users/kkrausse/Documents/repos/kkrausse/vivari-reset-completion-clean`.
  `native-build-provenance.json` preserves the tracked-input baseline, hashes and
  original JS-worker build receipt. The new runtime archive itself has no generated
  native outputs and is not claimed independently executable.
- Workspace/chat library JS and declarations built separately from the committed
  archive against the actual matching built SDK. Consumer resolution uses built
  library paths, never aliases those package imports to implementation source.
  All public package export targets exist. Existing receipted CSS copied unchanged.
- Normal committed preparation helpers performed fresh dependency installation,
  runtime-selected WASM backend checks, source capture, gzip bundle and managed VFS
  image generation from the new local library packages. This preparation did use
  build-time registry downloads (including 34 resolved/downloaded/extracted items),
  not a network-disconnected build; “offline” here means no live app/browser/runtime
  operation. Bun install is recorded in `command-7.json`; original frozen lock
  installation and derived-lock validation are the unchanged preparer's checks.
- Backend assertions: esbuild-wasm 0.28.2, @rollup/wasm-node 4.63.1,
  lightningcss-wasm 1.32.0, @tailwindcss/oxide-wasm32-wasi 4.3.3.
  Bundle hash `442fce36571805ab7b4b809b6b80b13e7469f418bbf7cb53165df47dc517aa6a`;
  image hash `4eef600c73dc9b180c863ee50c0708795c983a8fc9817b5a056861c33193efae`.
- OpenCode 2.0.3 application outputs recovered read-only from the old full stage's
  pinned receipt and rechecked by the normal actual-delivered application verifier.
  Only these independent application outputs were reused, not old libraries,
  workers or prepared dependencies. Server remains actual-648:
  `648140f53c48820106d4727fd29f1914f8f86a4e2c3f3430551eb9dd41a806b5`.

Library declarations and strict consumer checks passed. The historical full-suite
consumer check keeps its original `noUncheckedIndexedAccess` setting (off); the
libraries use it on. No generic unit tests were added or run for this preparation.

Complete host wiring is frozen as `qa/live-host.ts`, `qa/live-backend.js` and
`qa/live-api.js`; editor JS/CSS are under `client/`. An in-process, no-listener
check imported those handlers and received 200 from
`/editor/runtime/distribution.json` and `/editor/prepared/manifest.json`, both with
the matching version. API adapter/router exports exist. Evidence outside frozen:
`offline-wiring-verification.json`. That observer first queried the nonexistent
`/editor/distribution` and got 404; corrected to the actual app's unchanged route.
No runtime behavior was tested by those handler reads.

Selected hashes:

| Output | SHA-256 |
| --- | --- |
| Editor JS | `98c927872253ffbfbc1091f8c3f1c3d5dbe047f5165bce4cc378e6f761e896ed` |
| Editor CSS | `7c47462f2267dfd0152d24f390b906987ddfec4eacb41fd721ecf0a6bdf9ac40` |
| Full acceptance client | `63f77f41dd2b2cba00a56555024d49ae364e45ebf506763cc807fba7e1a25310` |
| Prepared manifest | `00c58fb5a5af99d0820b5dd17ed91f48fa658866d0885daf71e233f72d911ad4` |

## Original command and narrowly named QA adaptations

The original full command is unchanged:

```sh
SINGLE_KERNEL_AUTHORIZE_RUN=yes bun examples/todo-app/tests/single-kernel-driver.ts <prepared-output> <new-evidence-directory>
```

It rejects this repair because line 54 hard-pins e35. The original
`prepare-single-kernel-full.ts` likewise accepts only a frozen full e35 input;
neither file was edited or bypassed by relabelling this candidate. New frozen
`qa/conservative-full-app-driver-qa.js` changes only exact revision admission to
33fa135 and the driver-source-check root to the isolated committed archive.
Reversing these substitutions reproduces the original driver text byte-for-byte.

Separately named `conservative-full-client-qa.ts` changes only the fetched-body
fixture's host origin from `location.origin` to the same scheme/port with
`host.vivari.internal`. Reversing that replacement also reproduces original text
exactly. Guest `127.0.0.1` is the virtual network, not the listening host. The app's
unchanged `start-editor.ts` already uses the supported alias for its host backend.
No production app/library/runtime change was made.

**No actions, assertions, stage ordering, generation count, retries or deadlines
changed.** Retained full workload: foundation filesystem/spawn/capture/fetched-body/
watch/stream/persistence stages, five hydrated TODO CRUD/PDF generations, same-document
HMR, OpenCode SSE handshake/cancellation, reload durable marker, all original
focused cases 0–9 and all their steps, zero-work checks and actual Chrome worker
censuses. Post-close deadline stays 15 seconds; failed observations stop the cohort.
This suite makes no model inference call; model route is prohibited.

## Activation commands for the next independent owner — NOT executed here

Never serve/write receipts into frozen. Create a new nonexisting run copy for each
cohort (the copy helper was executed/verified offline after repairing Bun's root
directory `cp` EEXIST behavior; the failed empty copy is preserved).

```sh
FROZEN=/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/conservative-full-app-Yb8T8p/frozen
# Choose NEW absolute paths outside FROZEN. Do not reuse a previous cohort.
RUN=<new-absolute-run-directory>
EVIDENCE=<new-absolute-evidence-directory>
bun examples/todo-app/tests/conservative-full-app-prepare.ts --run-copy "$FROZEN" "$RUN"
# Separate owned foreground/background jobs; both ports are OS-assigned.
bun "$RUN/qa/serve-single-kernel.js" "$RUN"
bun "$RUN/qa/serve-single-kernel.js" "$RUN" --contracts
SINGLE_KERNEL_AUTHORIZE_RUN=yes bun "$RUN/qa/conservative-full-app-driver-qa.js" "$RUN" "$EVIDENCE"
```

The editor cohort needs a **separate** new run copy/origin after full-suite cleanup:
`bun "$RUN/qa/live-host.ts" "$RUN"`. It serves the actual WorkspaceEditor,
prepared assets, preview and TODO API. Providers are empty and `/editor/model/`
is 403: **do not send a prompt** expecting inference. A local fixture requires an
explicitly labelled QA transport; never turn on a paid provider to satisfy this
cohort. Native session create/export/import and UI hydration do not require a prompt.
The delivered server may refresh its model catalog in the background; zero inference
does not claim zero background network/work or remote-reference release.

Before launching, verify no existing origin receipts in the run copy; launch each
server exactly once. A failed startup is not permission to replay it against that
same origin. Retain the PID, command, port, run-path and owned Browser Control
session identity. Frozen hash verification happens before serving; repeat after QA.
Keep the complete preparation directory available: compiled driver's source-hash
checks intentionally depend on its isolated source archive extraction.

## Finite integrated live acceptance contract

Parent assigns one independent visible Browser Control CLI owner only after the
current guest-egress routing followup releases the slot. No parallel live jobs.

1. Run the full original suite once through the above exact QA wrapper, no retries.
   Install the retained close observer before navigation if correlating native
   terminate, owner Web Locks and CDP targets; preserve the original census/deadline.
2. Fresh editor cohort: create owned A/B workspaces and distinct source markers plus
   native sessions via normal controls/finite native APIs, no inference. Record source
   hashes and actual native exported bundles, not only visible transcript text.
   Run A→B→A twice (four ordinary switches), checking each incoming source, remapped
   native ID/parent hierarchy, session/model selection, hydration, enabled admission,
   preview CRUD and HMR. Verify kernel continuity and both service restarts; never
   request installed-cache retention or OpenCode/Vite process reuse.
3. One interruption: hold the incoming prepared-manifest request with QA route
   interception, observe that the outgoing source/native bundle and pending incoming
   image are durably in the real IndexedDB catalog **before incoming-ready**, then
   reload once. Release the hold, verify the actual recovery UI restores the original
   outgoing source/native sessions and catalog active identity; preserve raw journal
   bytes and before/after hashes. Do not use a fixed sleep as the durability oracle.
4. One owned startup failure: reject exactly one incoming startup manifest request
   with 503 (after durable pending and replacement), retain the failed state, then
   use the app's real Recover outgoing control once with normal responses restored.
   Verify original source/native sessions, clean outgoing identity and no duplicate
   live services. This is a labelled request fixture, not a production startup repair.
   If those request checkpoints cannot be observed, stop and report the concrete QA
   setup gap rather than weaken the ordering or simulate an accepted recovery.
5. At each stopped boundary record joined chat disposal, execution exit/stop/output
   readers and endpoint settlement, plus sampled registry counts for processes,
   listeners, HTTP, fetch interests/pins and lazy loads. On any cleanup failure retain
   attachment/pending and prohibit replacement/fallback; registry absence alone is
   not the join receipt. At final close correlate native termination/locks/targets
   within the unchanged deadline. Preserve screenshots and browser logs/errors.
6. Join only owned host exits, independently verify exact PIDs/ports absent, delete
   only owned Browser Control sessions after retaining evidence, release owned lock,
   and archive run outputs. Failure page destruction/SIGTERM is failure cleanup,
   never orderly guest acceptance. No exploration/user-origin storage is cleared.

Optional serialized headless coverage follows visible cleanup and uses matching
Playwright/browser versions; it is separately labelled, not a substitute for the
visible cohort. These finite editor cases are conditions for the next QA owner,
not claimed implemented automation or completed checks.

## Explicit preserved limits and preparation failures

- Planted `/bin` ancestor symlink can redirect a lazy tsgo installer into an audited
  cache after successful execution stop. It is not fixed here. Controlled acceptance
  may establish pristine delivered `/bin` and source ancestors via a bounded read-only
  guest lstat/hash receipt and reject unexpected state without deleting user links.
  Finite app passes and sampled zero lazy loads **do not prove global all-writer
  quiescence**, qualify tampered trees, or admit retention-on.
- Full `markAsUncloneable` runtime contract failure remains. Inherited handshake-
  disposal timing flake and historical full case-1 post-close census failure remain;
  neither prior bounded passes nor this build erase them.
- Initial preparation attempts are preserved as separate siblings: bad abbreviated
  ancestry reference; missing canonical OpenCode package (recovered only pinned
  application outputs); test-library build missing SDK resolver; historical consumer
  rejected under an extra nonhistorical unchecked-index setting; one outer 120-second
  install timeout. Final run used a 600-second build budget, not increased live
  acceptance budgets. Timed-out preparation descendants were checked absent before
  the fresh build. No partial sibling is advertised runnable.
- No pins, shared dist/.runtime/generated output, frozen owner/historical stage,
  production app/runtime source, browser origin or concurrently staged work changed.
  Build dependencies were reused through read-only node_modules symlinks. Only this
  runner/report are owned repository changes. No push.
