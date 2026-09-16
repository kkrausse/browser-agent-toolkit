# Local TypeScript packages

`@kev-browser-agent-kit/workspace@0.1.0` is a private, locally packable ESM package.
Nothing is published. Generated JS/declarations and runtime payloads are ignored.

## Public entrypoints

| Import | Environment / contract |
| --- | --- |
| `@kev-browser-agent-kit/workspace` | Browser Workspace, Runtime, storage, endpoints, previews and tools |
| `@kev-browser-agent-kit/workspace/react` | React 18/19 peer; WorkspaceEditing controlled boundary, WorkspaceProvider, useWorkspace, WorkspaceController and types |
| `@kev-browser-agent-kit/workspace/assets` | Bun/Node build/server only; readRuntimeAssets, copyRuntimeAssets, RuntimeAssetManifest |
| `@kev-browser-agent-kit/workspace/server` | Server-only authorizeEditorRequest(Request, appPolicy); denial Response or undefined |

The React entry imports the public core entry, keeping runtime class identity shared.
Core imports do not load React. No entry starts workers on import. Provider mount
creates only a controller/subscription; `controller.open()` acquires storage and
`startRuntime()` starts execution. SSR renders the initial snapshot. Browser
StrictMode effect replay uses deferred disposal; DOM/browser verification is pending.

The provider owns its controller. Call `controller.run(label, task)` to serialize
actions; failures are reported in `state.error`, not rethrown from `run`. Direct
methods reject normally. `close()` stops services/runtime, flushes and releases
storage; `dispose()` permanently aborts the controller. Reopen after `close`,
create a new provider after disposal. Existing origin lease constraints apply:
only `id: "default"`, one workspace owner per origin. Source seeding, ports,
Vite/OpenCode preparation, authentication and chat UI remain application recipes.

`onDiagnostic` is optional and captured on mount. Events include run ID, timestamp,
stage/operation elapsed time and redacted bounded data (16KB event payload cap).
There are no package diagnostic upload URLs, timers that upload, or network sinks.
The controller retains at most 160 activity strings. The application must bound
any diagnostic event retention it chooses; observer failures cannot break cleanup.

## Build and install locally

From this package directory, using Bun and TypeScript:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
bun pm pack --filename /absolute/output/kev-browser-agent-kit-workspace-0.1.0.tgz
```

`pack` runs the JS/declaration build. Its output contains `dist/lib`, documentation
and package metadata, excluding sources, build scripts, dependencies and runtime.
Build before running consumers; don't rebuild the package concurrently with a
consumer typecheck. A package build replaces `dist/lib`.

In an unrelated Bun TypeScript React project:

```sh
bun add /absolute/output/kev-browser-agent-kit-workspace-0.1.0.tgz react@19.1.1 react-dom@19.1.1
bun add -d typescript @types/react @types/react-dom @types/bun
```

Alternatively set `"@kev-browser-agent-kit/workspace": "file:/absolute/path/to/workspace-api"`
in dependencies **after building**, then `bun install --ignore-scripts`. That
development dependency may be symlinked; a tarball is the independent delivery.
Use public imports only:

```tsx
import { WorkspaceProvider, useWorkspace } from "@kev-browser-agent-kit/workspace/react";
function Status() {
  const { state } = useWorkspace();
  return <p>{state.status}</p>;
}
export function App() {
  return <WorkspaceProvider><Status /></WorkspaceProvider>;
}
```

## Explicit runtime delivery

Runtime version is derived from its build receipt and service-worker adapter,
separate from package semver. Read it from the generated `distribution.json`.
Workers, WASM and SW must travel together as a separate versioned directory/archive.
The npm package does not find a sibling `.runtime` directory or build your runtime.

Developer preparation only, from the repository root, with the pinned checkout
and toolchain prerequisites in [the runtime guide](../vivari/DEVELOPMENT.md):

```sh
bun vivari/scripts/build-runtime.ts patched
bun workspace-api/scripts/distribution.ts /absolute/delivery/runtime-VERSION
tar -czf /absolute/delivery/runtime-VERSION.tgz -C /absolute/delivery/runtime-VERSION .
```

Skip the runtime rebuild when its reviewed compiled output already exists. Send
the resulting archive to the consumer. In the consumer, unpack it into a delivery
directory, then use **the installed package** in a Bun build-time script:

```ts
import { mkdir } from "node:fs/promises";
import { copyRuntimeAssets } from "@kev-browser-agent-kit/workspace/assets";
await mkdir("public/editor", { recursive: true });
const manifest = await copyRuntimeAssets({
  source: "/absolute/unpacked-runtime-VERSION",
  destination: "public/editor/runtime-VERSION", // must not exist
  expectedVersion: "<version from the reviewed distribution.json>",
});
console.log(manifest.version);
```

The API checks ABI, version, safe manifest paths, kernel hash and SW presence;
it copies the entire asset tree. It is not a signature verifier or a complete
asset hash manifest. A copy I/O failure can leave a partial destination; remove
only that build-owned directory before retrying. Existing destinations reject.

Serve that directory at `/editor/runtime-VERSION/`, preserving file names and
correct JS/WASM MIME types. Supply `Distribution` with that `assetBaseUrl` and
the manifest's exact version. Serve the application with
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`; the SW script response also requires
`Service-Worker-Allowed: /` because preview registration currently has root scope.
Use localhost or HTTPS. No root-absolute nested worker paths are needed.

Prepared Vite/OpenCode source/dependencies are separate application artifacts,
not part of this runtime or library tarball. The TODO example uses the chat
package's preparer and recipe; see [its setup guide](../examples/todo-app/README.md).

## Reproducible independent smoke

With `dist/runtime` already prepared:

```sh
bun run test:consumer
# Optional: WORKSPACE_SMOKE_TMP=/your/temp/root bun run test:consumer
```

This packs and installs into a fresh directory outside the checkout, installs its
own React/TypeScript dependencies, checks declarations under strict NodeNext
without skipLibCheck, builds a browser React app, verifies SSR/import laziness
with throwing Worker/fetch stubs, tests redaction, and uses only the installed
public asset API to relocate a separately delivered runtime archive. Every
relocated file is SHA256-compared. It prints the retained directory and writes
`receipt.json`. This proves package contents/type/build/relocation, **not** browser
runtime boot, DOM StrictMode lifecycle, service-worker routing or product UX.

## Product-mode boundary

`WorkspaceEditing` is optional and controlled: `allowed`, `enabled`, `start`,
`retryKey`, `isPreviewReady(state)` and `renderEditor(context)`. Its children remain
mounted; the boundary hides them only after the caller's readiness predicate passes.
No recipe, ports, workers or services start on import/mount. `start(controller)` runs
only while allowed+enabled. The demo dynamically imports editor/recipe then; the
generic package does not import Vite or OpenCode. `renderEditor` stays host-owned.

```tsx
<WorkspaceEditing allowed={isAdmin} enabled={editing}
  start={controller => recipe.start(controller)} retryKey={retry}
  isPreviewReady={state => state.clients.preview === "ready"}
  renderEditor={({ controller, state, active }) => active
    ? <Editor state={state} onExit={() => {
        setEditing(false);
        void controller.cancelAndClose().catch(showCleanupError);
      }} /> : null}>
  <DeployedApp />
</WorkspaceEditing>
```

Call `cancelAndClose()` **outside** `run()` to abort immediately, await the current
operation and close/release resources serially. Repeated calls share cleanup;
failed cleanup can be retried. Recipes must observe `controller.signal` and await
all launched work. The controller's signal renews after successful close. StrictMode
effect replay defers admission/disposal. DOM acceptance remains with fresh QA.

Server policy is independent: call `authorizeEditorRequest(request, yourSessionRolePolicy)`
before serving every editor asset or model/tool request. Undefined permits; otherwise
return its 403 Response. Hook errors deny. `/server` is not imported by browser/core/
React entries. The local demo's `LOCAL_EDITOR_ADMIN=1` loopback fixture is explicitly
not a production identity system; replace it with existing application authorization.

`endpoint.attachPreview(iframe, { hostPaths: ["/api"] })` uses caller-selected
root-absolute segment prefixes. With the matching rebuilt runtime SW, `/api` and
`/api/...` from that iframe use native Fetch with the original Request and streamed
Response. `/apix` remains guest traffic; the default policy is empty. Native host
WS/EventSource is retained for matching paths too. Policy travels in reserved
`__vv_host_paths`, alongside listener query identity. It is routing, not security.

Relative `api/...` resolves under `/preview/PORT/`; use root-absolute backend paths.
Routers must account for the preview prefix and retain reserved query metadata;
removing it can lose routing after SW revival. OAuth callbacks/top navigation need
application integration and are not automatically equivalent to normal mode. The
guest is a separate React root: normal in-memory state is retained underneath, not
transferred into the guest. Source reset/restart remounts the guest, while backend
state remains external. Same-origin trusted editing is not hostile-code isolation.
