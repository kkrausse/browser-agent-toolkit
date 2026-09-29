# Editor performance handoff

## Goal and boundaries

Improve browser-editor cold download, warm startup, and workspace switching. Prove
reusable behavior in this toolkit's todo sample before a minimal IRS Tools
integration. Put caching/lifecycle machinery in libraries, not consumer scripts.
Workspace metadata caching is not the target; large dependency/tool payloads and
service initialization are. No subagents are needed for the current experiments.

This repository owns the implementation, findings, and future status reports.
`random` is historical reference only; no new toolkit work should be committed there.
The [measurement report](2026-09-29-editor-performance.md) contains the observations,
limitations, and validation results. This handoff does not require the old chat.

## Current state

- Implementation commit: `4fa27b0`. Report relocation/policy commit: `fc5d4d9`.
- Canonical checkout: `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit`
  on `main`. The `browser-agent-toolkit-upstream` directory was a Git worktree on
  `integration/upstream-runtime`, sharing the same repository and GitHub remote,
  not a separate repository. This handoff and accumulated integration work are
  being brought onto `main` at the user's request; continue in the canonical checkout.
- Opt-in experimental library APIs and isolated todo benchmark are committed.
- No production reuse/pruning defaults were enabled. No runtime source/pins changed.
- IRS Tools has no performance integration or experiment edits. Its separately
  committed save-before-switch work (`dda2e4a`) is unrelated and remains intact.
- The loopback benchmark server was stopped. Browser Control session
  `quiet-walrus-711` was deleted; create a new session when reproducing.
- Nothing was pushed. Working tree was clean before adding this handoff.

## Where the implementation lives

| Path | Purpose |
| --- | --- |
| `workspace-api/src/environment-experiment.ts` | Environment identity, full guest-side installed-tree verification, receipt invalidation/fallback, exact/incremental source replacement |
| `workspace-api/src/delivery.ts` | Opt-in `experimentalReuseInstalled`; exports `experimentalSourceReplacementTool` |
| `workspace-api/tests/environment-experiment.test.ts` | Identity invalidation, changed contents, partial-install receipt invalidation, topology/source replacement tests |
| `opencode-chat/src/prepared.ts` | `preparedApps(..., diagnostics, {experimentalReuseInstalled: true})`; known disposable Vite cache paths and diagnostic events |
| `examples/todo-app/tests/performance.ts` | Loopback-only server and baseline/maps/maps+native repacking |
| `examples/todo-app/tests/performance-client.ts` | Actual prepared todo fixture, static PDF workload, runtime/service lifecycle variants, timings/source verification |
| `examples/todo-app/tests/performance-acceptance.js` | Browser Control execute body; PDF and source checks before/after switching |
| `examples/todo-app/tests/README.md` | Harness operation and qualification constraints |

The source replacement API is nontransactional and assumes exclusive ownership
after ALL previous readers are stopped/drained. It preserves only managed
dependencies/backends and the experiment cache, resets `/.server`, and deletes
other outgoing source. Do not apply it directly to saved user workspaces.
Prepared source identity is provenance, not dependency compatibility or current
dirty-source identity. A saved receipt alone is not proof that packages are intact.

## Findings and decisions

- Todo image: **44.1 MB → 38.2 MB** after stripping maps and workspace native files
  (**13.3% smaller**). That candidate started OpenCode, rendered the app, generated
  PDFs, and added a todo. Maps-only was not independently browser-qualified.
- Keeping the kernel is feasible, but did not demonstrate a switch speedup:
  full-reset switch 31.0 s versus retained-kernel/reinstall 34.4 s.
- Cached image reinstall costs roughly 1–3 s. Full installed-tree verification
  costs roughly 12 s, so this cautious reuse implementation is **not a fast path**.
- Installed receipt persisted across close/reopen; `node_modules` did not.
  The runtime's ordinary OPFS mirror excludes it. Managed image delivery does not
  engage the separate package-manager dependency snapshot mechanism.
- Incremental replacement wrote one changed file and retained 24 unchanged files,
  but was slower than ordinary installation for this small source fixture.
- Vite/OpenCode startup dominates end-to-end waits. Early service times were about
  24–40 s for OpenCode and 30–44 s for preview, running concurrently, NOT additive.
- These are single samples with drift. Early readiness measured fresh SSR;
  the final fixture requires hydration plus enabled input and statically imports
  PDF code. Do not compare those generations as controlled speedup measurements.
- First full-reset switch with final static PDF fixture passed; a subsequent switch
  failed clearing `/workspace/node_modules` with `ENOTEMPTY`. Repeated switching is
  **not qualified**. The acceptance script failed honestly, and the client now
  marks failed switches not ready. No runtime reset fix was attempted.

Do not enable installed reuse in IRS Tools. Do not trust marker-only reuse. Smaller
payloads are a real cold-transfer opportunity, not proof of faster warm switching.
Earlier IRS repacking measured 81.4 → 48.3 MB, but those candidates were never
functionally qualified; todo `pdf-lib` does not reproduce IRS `pdfjs-dist` behavior.

## Reproduce

Canonical repository on the original machine:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit`.

For a fresh checkout, follow the root README's verified OpenCode setup and
`vivari/DEVELOPMENT.md` for pinned runtime setup/build/distribution. Generated
OpenCode/runtime artifacts are not committed. Use Bun 1.4.0. Do not edit generated
`.runtime` output; runtime source is `vendor/vivari` or `VIVARI_SOURCE`.

Build libraries from the repository root:

```sh
bun run build
```

Then from `examples/todo-app`, refresh copied local packages and prepare:

```sh
bun install --force --linker isolated --frozen-lockfile
TAILWIND_CANDIDATE_RECEIPT=/absolute/path/to/receipt.json \
TAILWIND_CANDIDATE_SHA256=<verified-receipt-sha256> bun run prepare:editor
bun tests/performance.ts
```

Build a receipted Tailwind backend using the todo README instructions. The original
run used an existing verified backend cache read-only at
`/Users/kkrausse/Documents/repos/kkrausse/irs-tools/.cache/tailwind-wasm/456722dd32ebba38e957bf9560eaab820936e8c16132d14b5c861381793adc9a/receipt.json`,
digest `456722dd32ebba38e957bf9560eaab820936e8c16132d14b5c861381793adc9a`.
That local shortcut is not a portable prerequisite; use your verified backend.

The server is `http://127.0.0.1:43187`. It must remain loopback-only and isolated
from actual application/workspace origins. There are no model calls or secrets.
Its host todo API is in-memory and deliberately persists across fixture switches;
it is not a saved-workspace persistence test.

Use the Bun-backed Browser Control CLI, never its MCP server:

```sh
browser-control execute 'await page.goto("http://127.0.0.1:43187/?variant=baseline&candidate=maps-native"); return {url: page.url(), snapshot: await snapshot()}'
```

Continue with the returned exact session ID, from the repository root:

```sh
browser-control execute --session <returned-id> \
  --file examples/todo-app/tests/performance-acceptance.js
```

Allow long execution time when invoking through a tool. Playwright long waits use
`page.waitForFunction(predicate, null, {timeout: 120000})`. The script makes one
switch; run it again on the same live workspace to exercise repeated switching.
Do not suppress/reset away the `ENOTEMPTY` failure to make the gate green.

Variants: `baseline`, `kernel`, `dependencies`, `incremental`, `reload`.
Candidates: `baseline`, `maps`, `maps-native`. All non-reload startup variants clear
the isolated store. To test persistence, close through
`window.editorPerformanceExperiment.stop()` before navigating to `variant=reload`.
Switching stops Vite/OpenCode in every variant; retaining their processes has NOT
been implemented or tested. Kernel retention alone retains the host kernel, not
their process-local loaded code or caches.

Evidence/API: `window.editorPerformanceExperiment` exposes `samples`, `events`,
`verifySource()`, `resources()`, `diagnostics()`, `switchWorkspace()`, and `stop()`.
Original JSON evidence exists locally in the former worktree at
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-upstream/examples/todo-app/.editor/performance/evidence/`, including
`repeated-reset-failure.json`. These artifacts do not travel with the Git checkout;
the committed report preserves conclusions and the harness can regenerate evidence.
Generated build/preparation output and the gitignored vendor runtime also remain
worktree-local; merging tracked source does not provision them in the main checkout.
`--sizes-only` repacks without serving. Rebuild libraries after library changes;
the server rebuilds the benchmark client on request with a canonical SDK instance.

## Validation and known harness issues

- Toolkit build and package/todo typechecks passed.
- Workspace tests: 32 passed with `umask 022`; an existing creation-mode assertion
  fails with the shell's restrictive umask. OpenCode: 121 passed, 2 skipped.
- Run build/package refresh sequentially before typechecking the todo app: build
  replaces library output and parallel checks can see missing package files.
- Bun copied peers previously produced two SDK instances and private WeakMap
  ownership mismatch. Harness resolution pins one canonical workspace package.
- Server must send `Service-Worker-Allowed: /` for preview SW registration.
- Lazy first PDF import caused Vite reoptimization/reload, discarding result markers;
  final fixture statically imports it and waits for hydration.
- No model-call/chat conversation acceptance or live agent dependency mutation test
  was performed. Package mutation/fallback coverage is currently unit-level.

## Next work, in order

1. Reproduce and diagnose repeated-reset `ENOTEMPTY`, including live process/readers
   and deletion semantics. Validate against packaged runtime, not only source tests.
2. Profile Vite and OpenCode startup separately with controlled repeated runs.
   Establish cold/warm cache state and consistent fully hydrated readiness.
3. Test keeping Vite warm for compatible source switches; prove removals, binary
   files, symlink safety, fresh preview, and stale-module invalidation. Keep full
   reset as fallback. Do not equate source changes with dependency changes.
4. Investigate OpenCode process reuse independently, with explicit project/session/
   configuration isolation. No cross-workspace state leakage is acceptable.
5. Implement reusable immutable dependency environment mounts/snapshots or trusted
   FS-worker mutation tracking. If using runtime snapshots, validate all managed
   roots (`/workspace/node_modules`, `/workspace/.browser-editor-backends`,
   `/opencode-v2`, `/app`), digest invalidation, tampering, partial failure and reload.
6. Broaden pruning qualification before enabling it in preparation.
7. Only after a meaningful, safe improvement is proven here, add a minimal library
   API consumption change to IRS Tools and smoke-test it. Keep its autosave intact.

Commit only your own files in each repository; do not push without authorization.
