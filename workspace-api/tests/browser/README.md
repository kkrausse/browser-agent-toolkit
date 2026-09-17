# Browser contracts

Small function-based tests of the public Workspace API against the built Vivari
distribution, in real Chromium workers and OPFS. No model, TODO server, Studio,
or external package install is needed for the guest fixtures.

## Run

From `workspace-api/`, with dependencies installed, a prepared `dist/runtime/`,
and the Bun-backed `browser-control` CLI connected to the browser extension:

```sh
bun tests/browser/run.ts
```

To select an existing distribution:

```sh
RUNTIME_DIR=/absolute/path/to/runtime bun tests/browser/run.ts
```

The runner checks the distribution ABI/features and kernel hash, prints its
version, bundles the current Workspace source, and serves both on a loopback
ephemeral port with COOP/COEP headers. Browser automation goes exclusively through
the Browser Control CLI. This is a connected-browser test command, not an
unattended Chrome installer/launcher.

It creates its own session, refuses an origin containing existing OPFS entries,
and clears only that verified test-owned store between cases and at completion.
Steps within a case retain storage across real document reloads. The session and
HTTP server are closed in `finally`; failures/timeouts/cleanup errors exit nonzero.
An externally killed runner may leave its session/storage behind; subsequent runs
refuse existing storage rather than silently resetting it.

## Add a case

Add an entry to `cases.ts`. Test bodies execute **in the browser**:

```ts
{
  name: "source round trip",
  steps: [() => browserCase(async ({ workspace }) => {
    const bytes = new TextEncoder().encode("hello");
    await workspace.fs.writeFile("/hello.txt", bytes);
    equalBytes(await workspace.fs.readFile("/hello.txt"), bytes);
  })],
}
```

`browserCase` opens a workspace and runtime, runs the callback, then stops the
runtime and closes the workspace even on assertion failure. Cleanup failures are
reported alongside the original failure. Each step has a 45-second deadline;
the CLI subprocess also has a 90-second outer deadline.

For persistence tests, add a second step: the runner reloads the document before
each step. Current persistence coverage is orderly close/reload, not abrupt
crash recovery (workspace close also flushes).

Primitives in `harness.ts`:

- `mount(workspace, files)`: write a file map, creating parent directories.
- `capture(execution)`: concurrently drain stdout/stderr, retain exact bytes,
  stream decoded logs, and return exit metadata. Default bound: 1 MiB per channel.
- `equalBytes` / `assert`: assertions without a browser test-library dependency.
- `log`: ordered events delivered to the Bun runner as tests execute.
- `vivari(workspace)`: **test-only** access to the same underlying Vivari host.
  It uses the current internal workspace map; this is an explicit internal
  coupling, not a new stable Workspace API. Prefer public operations and use this
  only for checks that need lower-level host capabilities. Its lifecycle remains
  owned by `browserCase`; do not destroy it or boot a second kernel.

Workspace filesystem paths are workspace-relative (`/hello.cjs`); runtime Node
entries use runtime-absolute paths (`/workspace/hello.cjs`). Guest fixtures run
inside Vivari, not native Bun.

Slow-reader/backpressure/overflow cases should consume raw execution or response
streams themselves: automatic capture would change the condition being tested.
Decoded console output is diagnostic; byte assertions use the original bytes.

## Initial coverage and extension points

- Failed callback propagates while running-process/workspace cleanup permits reopen.
- Binary stdin/stdout, stderr, EOF, natural exit metadata.
- Binary endpoint response/status, EOF-triggered HTTP server shutdown, endpoint close.
- Acknowledged file bytes restored after orderly close and browser reload.

This establishes the runner and initial contracts, not full runtime qualification.
Next cases can cover cancellation/slow readers/listener replacement, SQLite,
storage ownership, and persistence failures. Multi-tab orchestration and precise
fault injection should be added as small helpers when those cases require them.
Compatibility fixtures that already run under Vivari's headless harness should
remain there unless browser-specific behavior needs additional coverage.
