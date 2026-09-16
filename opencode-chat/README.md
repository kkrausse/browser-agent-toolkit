# @kev-browser-agent-kit/opencode-chat

The optional OpenCode integration/client package of **Browser Agent Toolkit**;
see the [project overview](../README.md).

Optional, locally packable OpenCode V2 chat. **The root is headless**: it imports
no React, DOM implementation, CSS, workspace runtime, service discovery or VM
library. `/react` provides a replaceable chat template. All traffic, including
SSE, uses the caller's endpoint.

**Pinned server:** published OpenCode `2.0.3`, tag revision
`d44b52ca66b6bf69626c0384626d1a9cd9555977`. See [PROVENANCE.md](./PROVENANCE.md)
for the release protocol audit and supported form subset.
See [PROVENANCE.md](PROVENANCE.md) and the distributed full MIT upstream notice.

**Client implementation:** official `@opencode/client/effect@2.0.3` with
`effect@4.0.0-rc.112`, matching the server release. Both are bundled into the
compiled browser/headless entries.

## Host integration

### Prepared browser editor

For the default prepared workspace, the optional `/editor` entrypoint composes
the provider, controller and recipe:

```tsx
import { PreparedBrowserEditor } from '@kev-browser-agent-kit/opencode-chat/editor';
import '@kev-browser-agent-kit/opencode-chat/editor.css';

// The host owns eligibility, useState(false), its Open editor button and lazy mount.
{allowed && isEditing && <PreparedBrowserEditor
  hostPaths={['/api']}
  onExit={() => setIsEditing(false)}
/>}
```

`base` defaults to `/editor/`; optional `base` and `model` are captured on mount.
The existing `BrowserEditor` accepts a host-owned controller and optional recipe
for lower-level composition. Both surfaces use the same editor lifecycle.
The wrapper uses the qualified OpenCode 2.0.3 preparation/recipe pin. The TODO
flow previously passed model edits, shell execution, Tailwind HMR and local retention
in the original repository. See the [current example setup](../examples/todo-app/README.md)
for this checkout; historical acceptance is not fresh browser qualification.

### Standalone chat

```tsx
import { createChatController } from '@kev-browser-agent-kit/opencode-chat';
import { ChatView } from '@kev-browser-agent-kit/opencode-chat/react';
import '@kev-browser-agent-kit/opencode-chat/styles.css';

// Create once per host-owned endpoint scope, outside rendering.
const controller = createChatController({
  endpoint: { url: endpoint.url, fetch: (input, init) => endpoint.fetch(input, init) },
  directory: '/workspace', // hidden caller location; never a directory picker
  // sessionID: 'ses_...',
  // autoCreateSession: true, // explicitly opt into mutation on empty bootstrap
});
await controller.ready;

// Give the parent a bounded height; the transcript scrolls inside the panel.
<div style={{ height: 640 }}>
  <ChatView controller={controller} showSessions showModels
    onOpenFile={(path, selection) => editor.open(path, selection)} />
</div>;

// Only when this endpoint scope is truly finished (not each view unmount):
controller.dispose();
```

React >=18 is an **optional peer**. Importing/installing the root does not require
React. Standard web fetch type declarations (`RequestInit`, `Response`) are
needed by TypeScript consumers, e.g. TypeScript's DOM lib or compatible server
fetch types. There is no DOM access in root JavaScript.

### Stable exports

- Root: `createChatController(options)` and public types (`ChatEndpoint`,
  `ChatController`, `ChatSnapshot`, `ChatOptions`, `PromptDraft`, `ModelRef`,
  native `SessionMessageInfo`, request types).
- React: `ChatView`, `useChatSnapshot`, `Transcript`, `MessagePart`, `ToolCard`,
  `Composer`, `PermissionCard`, `QuestionCard`, `Markdown`, `CodeBlock`.
- Explicit CSS: `@kev-browser-agent-kit/opencode-chat/styles.css`. All selectors scoped under
  `.oc-chat`; no reset, fonts, app assets, Tailwind or host routing required.
  Standalone presentation pieces can be wrapped in `.oc-chat` for these styles.
- `ChatViewProps`: `{controller, showSessions?:boolean, showModels?:boolean,
  onOpenFile?:(path, selection?:{startLine,endLine})=>void}`. Both controls default
  to visible. View unmount only unsubscribes, including Strict Mode remounts.

### Controller

Each controller owns a `ManagedRuntime` with an `OpenCodeAPI` service layer.
The layer supplies the caller's string/init transport to `FetchHttpClient` and
the official Effect client; native service discovery is never involved. The
official client encodes requests, validates responses and owns the shared SSE
source. Schema values are encoded back to the existing wire-shaped immutable
React snapshots, including numeric timestamps.

Controller actions are named `Effect.fn` programs. Connection and selection
scopes own request and subscription fibers; `Deferred` provides the connection
handshake, `Effect.all` fetches independent snapshots concurrently, and an
interruptible `Effect.sleep` coalesces recovery. Finalizers clear pending flags.
Selection, reconnect and disposal interrupt obsolete work; the public promises
for cancelled actions reject. Promises are the React/host boundary, rather than
the internal orchestration model. The upstream reducer still handles transcript
reconciliation and the React components retain their existing API.

`getSnapshot()` is referentially stable between changes and recursively frozen.
`subscribe(notify)` returns an unsubscribe function. Controllers are isolated.
`ready: Promise<void>` resolves after event handshake and initial hydration;
failures also appear in `snapshot.error`. Catch `ready` to handle host startup.

Actions return promises and reject on failure, also recording visible errors:

| Action | Meaning |
| --- | --- |
| `selectSession(id)` | Cancel prior selection's requests; hydrate chosen session |
| `createSession(title?) → Promise<string>` | Explicit creation and selection |
| `loadOlder()` | Fetch next descending cursor page and prepend in native order |
| `send({text})` | Submit native text prompt; preserve UI draft on failure |
| `selectModel({providerID,id,variant?})` | Persist explicit session model; `undefined` rejects because pinned API has no reset-to-default operation |
| `interrupt()` | Explicit server stop request, retained until authoritative idle/interruption; failure can be retried |
| `reconnect()` | Replace local subscription, hydrate authoritative history/requests/activity |
| `replyPermission(id, 'once'\|'always'\|'reject')` | Pinned permission response |
| `replyQuestion(id, string[][])` / `rejectQuestion(id)` | Backward-compatible question view; adapts question-tool forms to keyed form replies / cancellation |
| `clearError()` | Dismiss local operation error |
| `dispose()` | Abort only controller-owned requests/SSE/timers/listeners |

Snapshot fields: connection, sessionID, sessions, models, model, native messages,
execution (`idle/running/retrying/unknown`), interruptRequested, sending, loading,
loadingOlder, hasOlder, permissions/questions with per-request submitting/error, unsupportedForms,
and operation error. Disconnection becomes **unknown execution**, not success.
Step completion and prompt HTTP acceptance are not execution completion.

No default session creation, attachment uploads, endpoint lifecycle calls,
server stop/discovery, provisioning, route navigation or directory picker.
Persisted native files render as chips; tool file paths invoke the host callback.
Attachment composer controls are intentionally absent pending a tested upload
adapter and size accounting for the runtime's buffered request limit.

### Streaming and reconciliation

The pinned upstream native reducer preserves mixed content order, per-kind text
and reasoning ordinals, tool IDs, terminal text replacement, retries, shell and
compaction records. Unknown native records retain a readable fallback. Text and
reasoning are tokenized as Markdown; HTML is escaped, images are inert text, and
only safe links become anchors. Code fences support copy and incomplete tails.
Tool input/output/metadata/errors are collapsed and scroll-bounded.

SSE is live-only. Bootstrap establishes `server.connected` before history and
pending-request hydration. Selection/generation tokens reject stale results.
There is no server cursor shared by history and SSE: overlapping deltas are
**not replayed onto history**, which would duplicate persisted text. A short
authoritative refresh follows overlaps/missing reducer state and terminal
events. During overlap, the UI may display snapshot increments rather than
every token. Absolute request events reconcile over hydration; successful and
externally answered requests cannot be resurrected by stale snapshots.
Reconnect is explicit; there is no unbounded automatic network retry loop.

Transcript follow-bottom yields when readers scroll up. Loading older messages
preserves scroll height/position. Rendering uses stable message and tool keys;
completed unchanged message rows are memoized. Markdown retokenizes a changed
part; there is no worker/highlighter or DOM morphing pipeline.

## Build and verification

```sh
bun install
bun run typecheck
bun test
bun run build
bun pm pack --destination /path/to/artifacts
bun test/consumer-smoke.ts
```

Fixture coverage includes mixed ordinal semantics, ended replacement, missing
assistant, bootstrap/selection races, overlapping history/deltas, injected
transport/disposal, permission retry, question rules/removal, interrupt failure,
disconnect/reconnect, pagination and markup safety. Consumer smoke installs the
tarball outside this tree, checks headless installation without React, compiles
headless declarations and bundles/SSR-renders a separate React consumer.

The Effect migration additionally covers schema-invalid history, handshake
timeout/disposal, cancelled recovery fibers and the official client's byte-body
transport. See [historical Effect migration verification](https://github.com/kkrausse/random/blob/0bcad3e36753b51bdcad3234d75ac9fc30907966/browser-container-poc/doc/official-effect-client.md)
for the real-browser receipt and bundle measurement.

**Not yet verified live:** real guest prompt/tool/permission/question/stop flow,
browser clipboard and IME interactions, scroll/selection behavior and responsive
visual QA. Those checks belong to fresh host integration against the pinned
guest. Fixture evidence is not a claim of real-server/browser QA.
# Mounted browser editor

`@kev-browser-agent-kit/opencode-chat/editor` exports `BrowserEditor`,
`BrowserEditorProps`, `attachChat`, `chatFor`, `WorkspaceChatOptions`, and
`sourcePaths`. Install the optional `@kev-browser-agent-kit/workspace` peer when
using this integration. The root and `/react` standalone chat entries have no
workspace imports; the editor uses workspace types and the supplied controller.

```tsx
import { BrowserEditor, attachChat } from "@kev-browser-agent-kit/opencode-chat/editor";
import "@kev-browser-agent-kit/opencode-chat/editor.css";

// App owns authorization, launcher, isEditing, and when this subtree is mounted.
// Keep controller and recipe stable. The existing WorkspaceProvider can own it.
return isEditing ? (
  <BrowserEditor
    controller={controller}
    recipe={recipe}
    onExit={() => setIsEditing(false)}
    hostPaths={hostPaths} // stable array, e.g. ["/api"]
  />
) : null;
```

`recipe` has one requirement: `start(controller): Promise<void>`. Reuse the
existing workspace recipe: open/seed the workspace, start its runtime, and
`controller.launch(...)` the preview and OpenCode services. The defaults are
service names `vite` and `chat`; override with `previewService` and `chatService`.
The package attaches the preview iframe and a real `ChatView` to these services.
After launching chat, a recipe can `await attachChat(controller, service)` or
`await controller.waitForClient("chat")`. `attachChat` is idempotent for a service
and uses its existing `connection.fetch`, including authentication. For custom
names/directories pass `{ serviceName, directory }` to both the recipe adapter
and matching editor props. Default OpenCode directory is `/workspace`.

With `recipe`, the mounted panel starts once (including React StrictMode),
offers startup retry, and closes through
`controller.cancelAndClose()` on unmount. Retry/remount waits for prior cleanup.
The controller itself remains reusable; its provider owns final disposal.
Without `recipe`, the host owns starting/closing the workspace (for example via
the existing `WorkspaceEditing`). Supply `onRetry` for that lifecycle. Chat
clients live until their service is stopped or controller is aborted, so toggling
the chat pane does not reconnect. The iframe attachment is released on unmount.
The Exit button calls the host's `onExit` callback.

Preview readiness defaults to the attached iframe's load event. For an app that
renders asynchronously, provide a stable `isPreviewReady(frame)` predicate;
the package observes document mutations until it returns true. Such a predicate
requires a same-origin preview. `hostPaths` is passed unchanged to
`endpoint.attachPreview`, so API routing continues to use the existing bridge.

The panel provides chat and a live application preview. Ask the agent to edit
workspace files; the preview uses the application's existing HMR. Manual source
editing, file selection and autosave have been removed, including the
`initialPath`, `listFiles` and `autosaveMs` props. Hosts can still provide an
explicit `onReset` action. `sourcePaths` remains available for recipe seeding.

Workspace mount startup/cleanup, chat attachment and OpenCode readiness use named
Effect programs behind the existing Promise-based host API. Unmount interrupts
startup; remount waits for cleanup. Readiness cancellation aborts HTTP/body reads
and health-check backoff.

**Persistence scope:** “flushed” means the existing workspace filesystem's local
flush completed. It does not mean published, remotely saved, committed, or
persisted to an application server. This integration
does not add a remote persistence endpoint or change the OpenCode wire protocol.

`editor.css` includes the chat styles plus minimal scoped editor styles, and
needs no host Tailwind setup. Controls use package-local shadcn/ui Base UI
primitives with Tailwind 4 utilities and Lucide indicators. Both CSS exports
ship precompiled utilities: consumers do not install Tailwind, scan this package,
or import a separate UI stylesheet. There is no global preflight or theme;
utility classes, internal variables, and fallback initialization are isolated
from host styles. Select popups are portaled and carry their own package styles.
Install `react` and `react-dom` when using `/react` or `/editor`; both are optional
peers so headless consumers need neither. Base UI and the small styling helpers
are bundled into the UI entries.

It renders a full-viewport preview and a compact
fixed editing pane; applications can override its `oc-editor-*` classes.

## Prepared shared-application integration

The optional toolkit entries own the reusable build/server/runtime orchestration:

- `/prepare`: `prepareBrowserEditor({appRoot, output, runtimeDirectory, source, openCodeDirectory?})`.
  The verified OpenCode application ships beside the compiled preparer and resolves
  relative to the installed package, independent of cwd. `openCodeDirectory` is an
  optional qualified-build override. Toolkit maintainers must build the retained
  `../vivari/.runtime/opencode-release-2.0.3` artifact before building this package,
  or supply `OPENCODE_PACKAGE_DIR` to the package build. Only verified application
  outputs and their receipt are included; retained browser state is excluded.
  verifies the delivered workspace ABI and pinned OpenCode receipt, installs exact top-level
  application dependency versions with WASM esbuild/Rollup, and writes a content-addressed
  preparation manifest. `source` is an explicit app-relative allowlist. No guest frontend
  template is generated: the application's existing source and framework config are seeded.
- `/recipe`: `createBrowserEditorRecipe({base?: '/editor/', model?})` opens the existing
  workspace controller, seeds only missing source, installs hash-verified dependencies,
  launches real Vite and OpenCode, and waits for the mounted editor's clients. The editor
  owns chat attachment; the recipe does not create a second chat controller.
- `/server`: `createBrowserEditorHandler({authorize, preparedDirectory, runtimeDirectory,
  clientDirectory, model: {baseURL, headers}, base?})` returns a request handler whose
  `undefined` result delegates to the app. It protects preparation/runtime assets, the
  build's private editor JS/CSS, and the streamed model proxy. Authorization errors deny.
  Client credentials/cookies are stripped from upstream requests. Protected artifacts use
  `no-store`. Apply `browserEditorHeaders` to the host document for worker isolation.
- `/vite`: `browserEditorBoundary('src/editing.tsx', 'src/editor-panel.tsx', authorize)`
  replaces the host-only editing entry with a null component in the guest, before its
  imports load. In the host build it records private dynamic-entry artifacts in
  `editor-assets.json`; in development it gates the private entry and toolkit files and
  excludes them from shared dependency prebundling. Keep the editor behind that dynamic
  entry. The app retains its authorization function, launcher, and editing state.
- `/config`: `browserPreviewBase()` supplies a framework router's deployment basename
  (`/` on the host, `/preview/5173/` in the guest). The Vite boundary uses that same base,
  restoring it after the workspace bridge strips its transport prefix, including HMR.
- Use upstream `@tailwindcss/vite` directly in the application's Vite config. The
  custom `browserCompatibleTailwind()` scanner has been removed because it lost valid
  candidates. Published Oxide/Lightning CSS WASM backends pass browser startup and
  initial transforms; TODO CSS HMR remains blocked in the bounded
  [historical browser attempt](https://github.com/kkrausse/random/blob/0bcad3e36753b51bdcad3234d75ac9fc30907966/browser-container-poc/doc/todo-upstream-tailwind-attempt.md). The current preparer's
  hardcoded dependency delivery has not been promoted to that diagnostic package set.

Example consumer: `../todo-app-demo`. It retains React Router framework SPA/prerender
and its existing tRPC React Query frontend against the real host `/api`. Supply
`hostPaths={['/api']}` and an application-specific `isPreviewReady` predicate to the
mounted editor to wait for hydration/data rather than merely iframe load.

Build packages in dependency order (`workspace`, then `opencode-chat`). Each build also
emits a compiled local package directory (`workspace-api/dist/lib`, `opencode-chat/dist`)
with the same public exports and no package-development dependencies. Consumers can use
these directories as `file:` dependencies; normal tarball distribution remains supported.
The todo checkout's installation is verified with Bun 1.3.9. Bun 1.4.0 in this environment
rejects sibling file dependencies as unsafe; use Bun 1.3.9 for that installation step.

Runtime/OpenCode distributions must be prepared separately; this API does not silently
download a moving runtime or model harness. Dependencies are restored each open because
the workspace's existing OPFS mirror excludes `node_modules`. Source and chat state are
browser-local. **No remote Git patch persistence or publishing endpoint is implemented.**
