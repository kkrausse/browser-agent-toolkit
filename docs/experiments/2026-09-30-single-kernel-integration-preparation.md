# Single-kernel integration preparation

Report path: `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-single-kernel-integration-preparation.md`.

## Chronology / current checkpoint

1. Read the integration workflow and fork plan. Runtime edits remain exclusively
   owned by the runtime agent in `/Users/kkrausse/Documents/repos/kkrausse/vivari-single-kernel`.
2. Inspected distribution packaging and the prior qualification driver. Packaging
   did not require an FS worker, but lacked an active-versus-retained worker graph
   check. Added literal emitted-URL/import traversal, receipt hash verification,
   safe path validation, source-checkout identity checking, and an opt-in
   `VIVARI_WORKER_TOPOLOGY=single-kernel` policy. Retained immutable assets remain
   verified/copied; old unreachable worker filenames are not renamed or fabricated.
   Reachable FS, HTTP, fetcher, or unknown worker assets fail the fork policy.
3. Added a separate consumer and preparation/serving scripts. Source libraries
   build first against the explicit fork host SDK; the consumer resolves emitted
   libraries/declarations, not workspace/chat source aliases. Runtime and library
   licenses/provenance are retained. A fresh output directory and OS-assigned
   loopback origin prevent interference with existing evidence origins.
4. Prepared bounded, one-attempt contracts for synchronous guest FS (newline names,
   stat/lstat/readlink, rename, binary read/write >1 MiB), host FS readback,
   HTTP slow-reader producer stall + exact 16 MiB byte verification, response
   cancellation, stale endpoint rejection, handler/shutdown synchronous FS,
   graceful stdin-EOF drain, zero-work diagnostics, and flush/close/recreate/reload.
5. Prepared four serial A/B/A/B application starts using the qualified controller
   lifecycle/readiness ownership and preview attachment fence. OpenCode readiness
   checks health/plugins/config/catalog without a model request. Each generation
   changes a real import target and creates a fresh PDF workload button. External
   Playwright hydration/todo/PDF checks are still required; HTTP readiness alone
   does not count as interactive success.
6. No runtime build, consumer preparation, browser session creation, browser
   acceptance, server restart, model call, push, or deployment occurred. Existing
   servers 43222/43223 and all previous origins were untouched.

## Runtime checkpoint interface required

The fork must return a clean committed built checkpoint, its revision, build
commands, and any changed protocol/host ABI before live tests begin. The integration
build receipt must then be regenerated using that explicit fork path. No canonical
vendor switch or production pin change is needed.

The prepared consumer currently expects `vv-diag` to retain existing process,
listener, HTTP and fetch queue diagnostics, plus an explicit `workers` object:

```ts
{
  kernel: 1,
  filesystem: 0,
  httpCoordinator: 0,
  fetcher: 0,
  other: 0,
  process: number,
  processPids: number[] // unique active worker-backed guest PIDs
}
```

This is an integration interface requirement, not a claim the runtime already
implements it. Adapt the harness to an equally explicit runtime-owned role/PID
inventory if the runtime agent returns a different shape; never manufacture
missing counters from the PID table. Python/LSP and any other optional workers
must appear in `other` rather than disappear from accounting. Required browser
service-worker relay targets are separately inventoried and allowed.

`single-kernel-topology.js` separately reads actual Chrome worker targets through
Browser Control's CDP session, restricts evidence to the fresh owned origin, and
cross-checks process-worker counts against runtime diagnostics. This script has
not been run. A relay inventory missing nested workers is a tooling blocker,
not permission to infer absent workers from SDK success.

## Runnable commands (after parent relays runtime artifact checkpoint)

Toolkit root:

```sh
export VIVARI_SOURCE=/Users/kkrausse/Documents/repos/kkrausse/vivari-single-kernel
export VIVARI_WORKER_TOPOLOGY=single-kernel
bun vivari/scripts/build-runtime.ts
bun test workspace-api/scripts/runtime-assets.test.ts examples/todo-app/tests/single-kernel-contract.test.ts
bun examples/todo-app/tests/prepare-single-kernel.ts
```

Preparation prints a new absolute artifact directory (`$OUT`). Dependencies must
be installed first, including toolkit TypeScript/React/Effect dependencies; this
fresh worktree currently has no workspace TypeScript install. Do not install by
retargeting a canonical vendor checkout. The isolated preparer resolves fork host
source explicitly and does not require the SDK's canonical vendor symlink.

For full app acceptance, first generate a fresh prepared todo/OpenCode payload
against `$OUT/runtime`, preserving the pinned OpenCode recipe and backend policy.
Then set `SINGLE_KERNEL_PREPARED=/absolute/path/to/prepared` and rerun the preparer
into a **different new** artifact directory. It rejects a historical manifest
relabeled to the new runtime. A source-built, matching-version prepared payload
and an isolated preparation-library command remain prerequisites for the full
application run; foundation contracts do not depend on that payload.

```sh
bun examples/todo-app/tests/serve-single-kernel.ts "$OUT"
```

Serving verifies frozen hashes and prints its fresh origin and owned PID. Use only
that URL. Browser Control CLI must run via Bun; never start/configure MCP:

```sh
bun "$(command -v browser-control)" execute 'await page.goto("http://127.0.0.1:NEW_PORT/"); return {url:page.url(),snapshot:await snapshot()}'
```

Retain the returned session ID. Initiate each long operation once and return
immediately; read its stored status in separate short CLI calls. Example:

```js
return await page.evaluate(() => {
  const runs = window.singleKernelRuns ??= {};
  if (runs.filesystem) throw Error('Already attempted');
  const run = runs.filesystem = {status:'pending'};
  window.singleKernelAcceptance.initialize().then(
    result => Object.assign(run,{status:'completed',result}),
    error => Object.assign(run,{status:'failed',error:String(error)}),
  );
  return run;
});
```

Follow with single attempts at `streaming()`, `recreate()`, and `apps()` four
times, each joined before the next starts. After each app start, inspect the
actual iframe, verify matching generation/workspace and enabled todo input,
perform a real todo interaction, arm the exact PDF button before one click,
and verify fresh positive PDF bytes without replacing its document. Reuse the
serial token/document identity semantics from `tests/reset-verifier.js`; do not
retry workload clicks or app starts. Browser driver wiring remains a post-artifact
checkpoint task.

```sh
bun "$(command -v browser-control)" execute --session SESSION --file examples/todo-app/tests/single-kernel-topology.js
```

Call `close()` and observe completion before a same-origin reload. After reload,
call `reloadCheck()` once, inspect retained marker bytes/zero-work diagnostics,
then `close()` once. Preserve first failures, owned pages and server evidence;
repair the failure in a new qualified attempt rather than counting a retry pass.

## Checks performed / remaining acceptance

- `bun test workspace-api/scripts/runtime-assets.test.ts examples/todo-app/tests/single-kernel-contract.test.ts`: **8 pass, 0 fail, 20 assertions**.
- External-import browser syntax bundle: **3 modules, success**; `git diff --check`: clean.
  These are offline preparation evidence only. Full generated-library declaration checking is in
  the preparer and remains pending dependencies/runtime checkpoint.
- No overall acceptance result exists yet.
- Additional priority contracts still need implementation/qualification after
  the runtime checkpoint: abort-signal propagation and SSE cancel, guest
  `execSync` child synchronous FS, child subtree cleanup/port reuse,
  OPFS delete/recreate + owner-lock release, concurrent writes/flush/watch
  ordering, SQLite transactions, and actual Vite HMR. The existing runtime's
  generic HTTP/process/storage cases should be reused where the runtime agent
  updates their old FS-worker boot harness.
- This is correctness qualification preparation, not performance comparison.
