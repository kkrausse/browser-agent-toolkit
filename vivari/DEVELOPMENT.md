# Runtime development

## Source of truth

Runtime repository: <https://github.com/kkrausse/vivari/tree/integration/upstream-runtime>.
Edit normal source files there and commit normally. The fork retains upstream
history, with `upstream` pointing at `maitrungduc1410/vivari`.

Default layout:

```text
kkrausse/
  browser-agent-toolkit/
    vivari/                  # integration scripts, not the runtime source
    workspace-api/
    opencode-chat/
    examples/todo-app/
    vendor/vivari/           # editable runtime fork, pinned by runtime-source.json
```

`VIVARI_SOURCE=/absolute/path/to/vivari` selects another checkout for host builds,
tests, and Vite source aliases. Do not edit the old `.runtime/patched` checkout or
export a new `0001-sqlite.patch`. Old handoffs mentioning that workflow are
historical. Source migration provenance lives in the fork's `FORK.md`.

## Setup

From the toolkit root, clone the pinned fork into `vendor/vivari`:

```sh
bun vivari/scripts/setup-runtime.ts
```

Use Bun and the qualified native toolchain: Rust 1.93.0 with
`wasm32-unknown-unknown` and `wasm32-wasip1`, wasm-pack 0.13.1. Use Node 24.18.0
for the qualified headless checks. The build does not install the Rust toolchain.
The workspace package's local host SDK dependency resolves through `vendor/vivari`.
For a different editable checkout, use a `vendor/vivari` symlink to it (before
installing dependencies) and set `VIVARI_SOURCE` to that same checkout so the host
SDK and worker distribution are built from matching source.

From `browser-agent-toolkit/vivari`:

```sh
bun run setup
bun scripts/build-runtime.ts
```

The build installs frozen fork dependencies, builds native artifacts when their
inputs change, and builds the SDK/workers. Normal working-tree edits are allowed.
There is no clone/reset/reapply cycle during ordinary development.

## Edit → build → check

1. Edit the fork's `packages/runtime`, `packages/kernel-host`, `packages/protocol`,
   or `packages/core`, following its AGENTS.md and ARCHITECTURE.md.
2. From this integration directory, run `bun scripts/build-runtime.ts`.
   Use `--native` to force rebuilding the native artifacts.
3. Run the relevant focused contract from the fork:

   ```sh
   node scripts/verify-runtime-contracts.mjs vm-import
   node scripts/verify-runtime-contracts.mjs
   bun run verify
   ```

4. Package the workspace distribution from the toolkit repository root:

   ```sh
   bun workspace-api/scripts/distribution.ts
   ```

5. Run the affected workspace/browser qualification and commit your own files
   in each repository. Do not count an import or zero exit as server acceptance.

For fast JS-only iteration once native artifacts exist, `bun run build:core` in
the fork rebuilds the SDK. Use the integration build before distribution
packaging so hashes, provenance, and retained assets are updated together.

## Reproducible builds and receipts

`bun scripts/build-runtime.ts --release` requires committed source. Check out an
exact fork commit when reproducing a release; a moving branch name is not a pin.
The shared source configuration records the qualified revision for setup and
qualification. Intentional upgrades update that pin after verification.

Receipts retain the compatibility filename `.runtime/patched-build.json`, but
record fork source provenance instead of patch hashes. Development provenance
includes dirty-state information; release provenance identifies a clean commit.
Workspace distribution packaging verifies emitted asset hashes against the
receipt and carries that receipt forward.

Build caches and retained immutable assets stay separate from editable source.
Running kernels may still need old hashed worker URLs: do not delete retained
assets during a normal rebuild. Restart/reload to adopt the new runtime.

## Adding tools

### Runtime-first compatibility target

Consumers should install/mount upstream applications and dependencies and launch
their ordinary command or supported entrypoint. No prerequisite package-hacking
scripts should be needed. Implement missing module/API semantics and reusable
JS/WASM backends in the runtime; normal upstream builds and generic asset delivery
remain legitimate preparation. Preserve lazy imports rather than requiring unused
TUI/native branches to resolve upfront. Application-specific runtime rewrites are
still exceptions, not general compatibility fixes.

Today's OpenCode and ripgrep packagers remain the qualified regression reference,
not proof those transformations are required. Investigate direct execution before
adding another transform, record concrete blockers and removal conditions, and
retire the scripts' compatibility rewrites after the replacement passes. See the
[original OpenCode case study](https://github.com/kkrausse/random/blob/0bcad3e36753b51bdcad3234d75ac9fc30907966/browser-container-poc/doc/opencode-runtime-case-study.md) for historical acceptance.

Keep the distinction between two extension surfaces:

- A model-facing OpenCode tool uses the pinned server's supported extension
  surface and lifecycle. This is part of the server cleanup milestone.
- A host-bound workspace helper uses `ToolDescriptor` and the existing
  `ToolContext`, independently of OpenCode's model-facing registry.

For example, this complete host-bound descriptor reads through the existing
runtime filesystem without adding a kernel opcode:

```ts
import type { ToolDescriptor } from '@kev-browser-agent-kit/workspace';

export const fileSize: ToolDescriptor<{ path: string }, number> = {
  name: 'file-size',
  version: '1',
  async bind(context) {
    return async ({ path }) => (await context.readFile(path)).byteLength;
  },
};
```

Register it with `Runtime.start({ distribution, workspace, tools: { fileSize } })`,
then call `runtime.tools.fileSize({ path: '/workspace/example.txt' })`.
`ToolContext` uses runtime-absolute paths, whereas public `workspace.fs` paths are
relative to the workspace mount (starting with `/`). This example reads the
whole file; use a future stat capability for a production large-file size tool.

For process-backed tools, use `context.node({ entry, args, cwd, env, signal })`;
drain stdout and stderr concurrently, close unused stdin, inspect the exit
result, and stop owned execution in cleanup. The existing
`workspace-api/src/tools/ripgrep/descriptor.ts` demonstrates asset delivery,
structured argv, result parsing, cancellation, and bounded output.

The current transport's overflow limits are not full backpressure. New tool
examples must not claim otherwise. JS/WASM package-backed tools should declare
and deliver their assets; adding a supported tool should not require a runtime
fork edit or a bespoke HTTP adapter.

## Active scope and historical experiments

The historical server cleanup plan remains in `random/browser-container-poc/doc/`.
The fork workflow, server-only baseline, and runtime-owned HTTP bridge are accepted,
including real-browser streaming/backpressure and read/edit/grep/glob with server
restart retention in the original environment; fresh qualification is separate.
P2 execution stream semantics and the JavaScript-first tool profile remain ahead.

OpenTUI, old OpenCode packagers, and cumulative patch experiments remain in the
original repository. This extraction retains runtime build tools, the current
OpenCode release recipe, the standalone ripgrep tool packager, and Tailwind backend
preparation. The cumulative runtime patch workflow is retired.
