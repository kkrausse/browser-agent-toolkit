# @kev-browser-agent-kit/workspace

The workspace package of **Browser Agent Toolkit**, providing browser implementations
of agent harness capabilities. See the [project overview](../README.md) for the
local example, build instructions, and package boundaries.

**Compatibility goal:** install/mount upstream packages, configure them and launch
their normal entrypoints without prerequisite package-hacking scripts. Runtime
loader/builtin shims and reusable JS/WASM implementations supply compatibility.
Normal upstream builds and generic dependency/asset delivery remain valid. This
is an end-state goal: current OpenCode delivery still has custom transformations;
see the [runtime development guide](../vivari/DEVELOPMENT.md).

Real Vivari worker-backed files, explicit execution, typed tools and endpoints.
Browser acceptance instructions are in [the TODO example](../examples/todo-app/README.md).

```ts
import { Workspace, Runtime, opfsStore, defineRipgrepTool, attachPreview } from './src';

const manifest = await fetch('/runtime/distribution.json').then(r => r.json());
const distribution = { name: 'vivari', version: manifest.version, assetBaseUrl: '/runtime/' };
const workspace = await Workspace.open({ id: 'default', storage: opfsStore(distribution) });
await workspace.fs.writeFile('/hello.cjs', `console.log('guest worker');`);
const runtime = await Runtime.start({ workspace, distribution, tools: {} });
const execution = await runtime.node({ entry: '/workspace/hello.cjs' });
const drain = async (stream: AsyncIterable<Uint8Array>) => {
  for await (const bytes of stream) console.log(bytes);
};
await Promise.all([drain(execution.stdout), drain(execution.stderr), execution.exited]);
await runtime.stop();
await workspace.fs.writeFile('/after-stop.txt', 'filesystem still alive');
await workspace.flush();
await workspace.close();
```

## Contracts

- Only `id: 'default'` and one origin's existing OPFS lease. Opening requires
  persistent storage; failed initialization/ownership rejects instead of silently
  using a different in-memory tree. Files map to `/workspace` for guest code.
- Runtime starts no project applications. Runtime stop kills its executions and
  descendants; storage remains alive. Workspace close rejects while attached,
  flushes, then releases workers even if flushing fails (and propagates failure).
- Flush acknowledges preceding accepted persisted mutations, not a checkpoint.
  **`node_modules` remains excluded from the existing OPFS mirror** and requires
  explicit dependency preparation/cache restoration on reopen.
- `runtime.node` uses the configured Node-compatible frontend by absolute path.
  This does not run native Node/Bun. No public Bun or shell-spawn method is claimed.
- stdout/stderr have one reader each; drain concurrently. Each channel allows
  1 MiB unread bytes including worker transit, split into at most 64 KiB frames.
  Overflow errors that channel and forcibly stops the process tree; it does not
  silently truncate. Cancellation of a channel discards it without killing the
  execution. Guest child-to-parent and synchronous capture queues are separate
  legacy channels, not covered by the top-level host byte budget.
- `exited` resolves `{exitCode, signal, forced}` once. Buffered final output precedes
  EOF. `stop()` is idempotent, forced subtree cleanup. stdin accepts bytes and EOF.
- `expose(port,{signal})` waits for a listener; `Endpoint.closed` reports loss.
  Handles do not retarget numeric-port replacements. Preview URLs carry reserved
  listener identity. Programmatic expose/fetch does not register a Service Worker.
- `endpoint.fetch('/path',init)` uses a runtime-owned streaming channel into the
  existing listener worker's real Node HTTP client. No per-request process is
  launched. Uploads and downloads use independent one-chunk (64 KiB) credit
  windows, with local socket backpressure reaching Node's write/drain behavior.
  Abort/body cancellation closes the actual guest connection. Headers cap at
  64 KiB; the supervisor allows 128 active requests. Bodies have no total-size cap.
  One caller-supplied upload chunk/current application write can exceed the window;
  callers must still respect their own stream backpressure. An unread response
  holds bounded buffers and an active slot until cancelled or its owner closes.
  Repeated headers are preserved subject to Fetch's browser restrictions (including
  filtering Set-Cookie). Redirect responses are returned manually;
  automatic following, cookie-jar integration, and browser-native Response URL/
  redirected metadata are not implemented. SW preview HTTP itself stays buffered.
- `endpoint.attachPreview(iframe, options)` owns its browser preview transport.
  It starts Service Worker registration lazily, then navigates the frame. Failure
  disposes the attachment and dispatches an iframe `error` event. Fresh-origin
  browser qualification covers registration/navigation after programmatic HTTP.
  The compatibility helper `attachPreview(iframe, endpoint, options)` delegates
  to that capability, so React entrypoints and separate package copies can attach
  without sharing a private registry or module identity. Browser globals are used
  only when attaching; importing the API/React entrypoint remains SSR-safe.
  Attachment validates sender window/origin and namespaces connection IDs
  per attachment. Detach closes its WS/SSE tunnels and clears the frame, not the
  listening server. Same-origin trusted embedding is not deployment isolation.
- `defineRipgrepTool({receiptUrl})` binds a callable `runtime.tools.ripgrep(options)`
  backed by verified JS/WASM artifacts. It does not install `/bin/rg`. Result limits
  default to 1,000 matching lines/1 MiB JSON output; truncation is explicit. Exit 1
  means no-match; regex/other failures throw `TOOL_FAILED`. Default ripgrep binary
  detection/ignore behavior applies; JSON base64 fields decode with UTF-8 replacement.
  Partial downloads are verified before install and conflicting existing bytes
  reject. General atomic bundle upgrades and application delivery are follow-ons.

## Checks

```sh
bun run typecheck
bun test
bun run test:consumer # tarball install, declarations, SSR, cross-copy preview, asset relocation
bun run test:workers  # real Node 24.18.0 worker_threads; macOS arm64 runner
bun run distribution
bun scripts/serve-contract.ts
```

`test:consumer` creates an endpoint through the installed React controller and
attaches it through the endpoint method, root helper, and another loaded package
copy. Its deterministic worker/DOM transport fixture checks routing, sender
validation, HMR forwarding and attachment lifetime; it does not replace live
browser/guest qualification.

`test:workers` uses real Rust VFS and process workers with a small headless Host
adapter. It is not proof of browser Worker startup, OPFS, Service Worker or HMR.
# Local package delivery

For compiled ESM/declarations, the reusable `/react` integration, server-only
`/assets` API, independent tarball install and explicit versioned runtime delivery,
see [LOCAL-PACKAGES.md](./LOCAL-PACKAGES.md). Existing source-oriented examples below
describe the core API; consumers should use `@kev-browser-agent-kit/workspace` public imports.
## Bulk prepared-tree installation

Tools can call `ToolContext.installTree({ roots, entries })` before starting
processes to replace disposable runtime-absolute trees in one FS-worker operation.
Entries are directories (path/mode), symlinks (path/relative target), or files
(path/mode/Uint8Array/SHA-256, optionally `verifyReadback`). The runtime validates
and hashes the complete input before deleting roots, then applies bytes and
metadata directly in the VFS. The caller retains its input buffers; views sharing
an archive buffer cross the page boundary in one structured clone. Results report
file count and verification/install/readback timings.

This is not a transactional live-tree replacement: call before readers launch,
and retry a failed write by replacing the tree again. Watch invalidations are
root-level. Keep source and database paths outside the disposable roots. Requires
a rebuilt distribution advertising `install-tree-v1`; older distributions reject
with a rebuild instruction. `installFile` retains its existing conflict semantics.
