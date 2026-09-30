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

The optional `/editor` entrypoint composes the provider and controller. The
application supplies its ordinary async startup function:

```tsx
import { PreparedBrowserEditor } from '@kev-browser-agent-kit/opencode-chat/editor';
import '@kev-browser-agent-kit/opencode-chat/editor.css';

// The host owns eligibility, useState(false), its Open editor button and lazy mount.
{allowed && isEditing && <PreparedBrowserEditor
  start={startBrowserEditor}
  hostPaths={['/api']}
  onExit={() => setIsEditing(false)}
/>}
```

`base` defaults to `/editor/`; `base` and `start` are captured on mount.
The existing `BrowserEditor` accepts a host-owned controller and optional startup
for lower-level composition. Both surfaces use the same editor lifecycle.
The OpenCode browser helper enforces the qualified OpenCode 2.0.3 pin. The TODO
flow previously passed model edits, shell execution, Tailwind HMR and local retention
in the original repository. See the [current example setup](../examples/todo-app/README.md)
for this checkout; historical acceptance is not fresh browser qualification.

#### Guest JavaScript execution

`installOpenCodeConfig` also installs the `editor.javascript` plugin. Startup
requires both editor plugins to be active. It removes the model-facing `shell`
tool and registers `runJavascript({ code, cwd?, timeoutMs? })` through OpenCode's
public tool transform. Read/edit/glob/grep remain available.

Each invocation runs a fresh ES module in a separate Vivari process, with
top-level await, imports resolved from `cwd` (default `/workspace`), and
`BROWSER_AGENT_GUEST=1`. This is the runtime's Node-compatible frontend, not a
native Node/Bun executable. It supports installed JS/WASM packages to the extent
their APIs are implemented by Vivari. The plugin injects this capability contract
and examples into the model context, including retained sessions after reopening.

Use package APIs directly when available. For CLI-only JS packages, use
`node:child_process.spawn('/bin/node.js', [entrypoint, ...args])` and forward its
streams/exit status. Package scripts must still be inspected for framework
generation steps and unsupported APIs; the tool does not silently translate Bun
commands or treat transpilation as a full typecheck.

Results report status, working directory, elapsed time, exit code/signal,
stdout/stderr, and timestamped launch/exit/timeout/cleanup diagnostics. Progress
updates are published while running. Inline output retains the first 32 KiB per
channel; complete output is retained under `/workspace/.server/javascript/` with
paths in the result. Timeout (60 seconds by default, up to 5 minutes) and Effect
interruption kill the guest process. Failure to confirm termination is explicit.
Temporary source files are removed after execution; output logs remain readable.

`bun run test:javascript` checks real Vivari workers, including JS/WASM imports,
TypeScript API/CLI execution, compiler errors, timeout, interruption and logs.

#### Model headers and application authentication

`installOpenCodeConfig` installs `editor.model-headers` through OpenCode 2.0.3's public global
single-file plugin discovery and verifies that it is active. Its provider-scoped
`session.hook('http.request')` moves native provider headers into
`X-Editor-Model-Headers` (base64 JSON header pairs, at most 8192 encoded bytes).
It removes the native outer headers, including `Authorization`, without reading
or replacing the native request body, URL, method, or abort signal. Browser
cookies and application authentication belong to the resulting outer request.

**Authenticate the original request normally** before calling
`createBrowserEditorHandler().fetch(request)`. No model-specific authentication
request clone or credential stripping is needed in the consuming application.
The envelope is transport data, not an application credential. The host rejects
missing/malformed envelopes with HTTP 400, accepts at most 64 unique lowercase
header names, and builds upstream headers exclusively from the decoded map.
Browser/app outer headers never become upstream headers. Hop-by-hop and browser
headers and guest provider credentials are removed; host-configured provider
headers override native values. Native protocol/session headers, request paths,
queries, bodies, and streamed responses retain the normal provider contract.

The hook covers primary, title, compaction, and session-generation HTTP requests.
WebSocket model transport is excluded and remains disabled by the qualified
OpenCode configuration. The current runtime's egress policy passes custom headers to the app host.
This change requires matching browser/server package versions and reopening the
editor so the plugin is seeded; it does **not** require regenerating prepared
application artifacts. Already-running older guests must be restarted.

Qualification uses the unchanged, hash-verified 2.0.3 server in the actual guest
runtime with a mock HTTP provider (no model credentials):

```sh
OPENCODE_PACKAGE_DIR=/absolute/path/to/opencode-release-2.0.3 \
NODE_BINARY=/absolute/path/to/node \
bun test test/model-headers.test.ts test/server.test.ts test/opencode-integration.test.ts
```

Run from `opencode-chat`; Node 24 and a non-loopback host IPv4 address are needed
by the opt-in headless probe. Ordinary tests also exercise both streaming
directions and cancellation over real HTTP. The qualification uses documented
global single-file discovery because explicit plugin-directory resolution in
the current runtime returns a filesystem path where OpenCode expects a file URL.

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
await controller.dispose();
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
  showHeader?:boolean, showFooter?:boolean,
  onOpenFile?:(path, selection?:{startLine,endLine})=>void}`. Both controls default
  to visible. Header and footer also default to visible and can be omitted for
  app-owned chrome. View unmount only unsubscribes, including Strict Mode remounts.

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
| `exportChats()` | Export every directory session (including parent-linked subagents) and every message page as a versioned, deterministic transcript archive |
| `send({text})` | Submit native text prompt; preserve UI draft on failure |
| `selectModel({providerID,id,variant?})` | Persist explicit session model; `undefined` rejects because pinned API has no reset-to-default operation |
| `interrupt()` | Explicit server stop request, retained until authoritative idle/interruption; failure can be retried |
| `reconnect()` | Replace local subscription, hydrate authoritative history/requests/activity |
| `replyPermission(id, 'once'\|'always'\|'reject')` | Pinned permission response |
| `replyQuestion(id, string[][])` / `rejectQuestion(id)` | Backward-compatible question view; adapts question-tool forms to keyed form replies / cancellation |
| `clearError()` | Dismiss local operation error |
| `dispose()` | Freeze admission and await controller-owned transport settlement, body cancellation, scopes and runtime disposal; does not interrupt/join remote server work |

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

`exportChats()` returns an `opencode-chat` version `1` JSON envelope. Sessions
and each session's messages are oldest-first (ties use IDs), and overlapping
session/message page boundaries are deduplicated by their IDs. The archive preserves
native attachment references present in message records, but does not fetch or
embed referenced bytes. Its `portability` field therefore declares
`attachmentBytes: "not-included"` and `resume: "unsupported"`; it is a chat
record, not a fully portable OpenCode session import.

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
Source-based harnesses must also use the compiled stylesheet, not `src/styles.css`
or `src/editor.css`: those omit the popup stacking and other `ocui:` utilities.
Run `bun run build:styles` in `opencode-chat` to produce `dist/editor.css` without
rebuilding OpenCode or the workspace runtime, then import that stylesheet.
Install `react` and `react-dom` when using `/react` or `/editor`; both are optional
peers so headless consumers need neither. Base UI and the small styling helpers
are bundled into the UI entries.

It renders a full-viewport preview and a compact
fixed editing pane; applications can override its `oc-editor-*` classes.

## Prepared shared-application integration

The optional toolkit entries provide concrete operations while the application
owns preparation and browser startup:

- `/prepare`: `prepareBrowserEditorDependencies(...)` performs dependency and
  OpenCode artifact preparation when called. `writeBrowserEditorSource(...)`
  refreshes the separate editable source delivery without reinstalling packages.
  The verified OpenCode application ships beside the compiled preparer and resolves
  relative to the installed package, independent of cwd. `openCodeDirectory` is an
  optional qualified-build override. Toolkit maintainers must build the retained
  `../vivari/.runtime/opencode-release-2.0.3` artifact before building this package,
  or supply `OPENCODE_PACKAGE_DIR` to the package build. Only verified application
  outputs and their receipt are included; retained browser state is excluded.
  verifies the delivered workspace ABI and pinned OpenCode receipt, installs exact top-level
  application dependency versions with WASM esbuild/Rollup, and writes a content-addressed
  preparation manifest. Source is an explicit app-relative allowlist. No guest frontend
  template is generated. The application owns the cache conditional; see
  `examples/todo-app/prepare.ts` for a plain `{outputDir, runtimeDir}` `runBuild()`.
- `/browser`: `installOpenCodeConfig(...)` and `startOpenCode(...)` own only the
  pinned OpenCode configuration, process, readiness checks, authenticated connection,
  and client barrier. They do not start Vite or choose application sequencing. See
  `examples/todo-app/src/start-editor.ts` for app-owned preview startup and parallelism.
- `PreparedBrowserEditor` discovers the authorized server's diagnostic setting and
  owns browser error listeners, lifecycle/process capture, batching and retries.
  No app-side reporter is needed. `diagnostics={false}` opts out of browser delivery;
  `onDiagnostic(event)` and `captureProcessOutput` remain available for custom local sinks.
  See **Diagnostics** below for the server switch and terminal reader.
- `/server`: `createBrowserEditorHandler({preparedDirectory, runtimeDirectory,
  clientDirectory, providers: {opencode: {baseURL, headers}}, base?})` returns `{matches, fetch}`.
  `matches(request)` identifies preparation/runtime assets, the build's private editor
  JS/CSS, and the model proxy. The app checks its own authorization before calling
  `fetch(request)`; an `undefined` fetch result delegates to the app. There is no
  authorization callback or policy adapter in the toolkit.
  When server diagnostics are enabled, model proxy events include a generated request
  correlation ID, method, fixed route paths, safe provider/model/client identifiers,
  OpenCode identity-header presence, elapsed time, upstream/downstream status, and a
  bounded provider error/category. They never retain authorization, cookies, query
  values, prompts, messages, tool bodies, or other request-body content.
  Client credentials/cookies are stripped from upstream requests. Protected artifacts use
  `no-store`. Apply `browserEditorHeaders` to the host document for worker isolation.
  Model routes are `${base}model/<providerID>/<native path>` (by default
  `/editor/model/opencode/responses`, for example). Only configured provider IDs
  are forwarded. Each server-only provider entry supplies its upstream API base
  (including `/v1` where needed) and credentials. The remaining path, query,
  protocol headers, request body, and HTTP response stream pass through without
  model-format translation. OpenCode uses `providers.<id>.settings.baseURL` to
  target that prefix while retaining its provider implementation. The recipe
  currently configures only `opencode`; adding a host route alone does not enable
  a provider in the guest. This proxy supports HTTP, not WebSocket upgrades.
  Chromium replaces the guest's `User-Agent`, so a provider that needs the
  OpenCode identity must receive it through the server route's `headers`.
  The TODO example restores `opencode/stable/2.0.3/vivari-opencode-server`, matching
  the pinned application's actual metadata. Keep it aligned with the prepared
  application's version/channel/name when upgrading. `x-opencode-session` and
  `x-opencode-client` are generated by OpenCode and forwarded unchanged; the host
  does not invent a session ID. A browser user agent with those headers still
  produced Zen's 403 `FreeTierError`; restoring the actual app user agent resolved it.
- `@kev-browser-agent-kit/workspace/vite`: `browserEditorBoundary('src/editing.tsx', 'src/editor-panel.tsx')`
  replaces the host-only editing entry with a null component in the guest, before its
  imports load. In the host build it records private dynamic-entry artifacts in
  `editor-assets.json`; in development it excludes toolkit files from shared dependency
  prebundling. It fingerprints installed client library bytes in the optimizer config,
  so restarting after a same-version `file:` rebuild changes immutable module URLs.
  The app's own Vite middleware uses
  `isBrowserEditorModule(request.url, 'src/editor-panel.tsx')` to identify editor modules
  and authorizes before calling `next()`. Keep the editor behind that dynamic entry.
  The app owns authorization, denial responses, the launcher, and editing state.
- `@kev-browser-agent-kit/workspace/config`: `browserPreviewBase()` supplies a framework router's deployment basename
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

Authorization stays visible at the application's request boundary:

```ts
if (await editor.matches(request)) {
  if (!await isEditor(request)) return new Response('Forbidden', { status: 403 });
  return await editor.fetch(request) ?? new Response('Not found', { status: 404 });
}
return serveApplication(request);
```

This API replaces the earlier `authorize` option, third Vite-plugin argument and
Workspace `/server` authorization adapter. Update app guards when upgrading.

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

## Diagnostics

The host owns authorization, enablement and storage policy. The toolkit owns capture,
sanitizing, transport, receiving-boundary validation, timing and CLI formatting.

```ts
import { createBrowserEditorHandler, createFileDiagnosticSink } from '@kev-browser-agent-kit/opencode-chat/server';

const diagnostics = createFileDiagnosticSink({
  directory: 'tmp/editor/diagnostics',
  enabled: process.env.EDITOR_DIAGNOSTICS !== '0',
  maxFileBytes: 1024 * 1024, // current file plus one rotated file
});
const editor = createBrowserEditorHandler({
  preparedDirectory, runtimeDirectory, providers,
  diagnostics,
  // Optional lazy preparation; called only when an authorized manifest is requested.
  prepare: scope => ensurePrepared(scope),
});
// After application authorization:
await editor.fetch(request, { actorId: authenticatedUserId });
// Optional app-specific denial/cache/policy events:
editor.diagnostic('editor.denied', { status: 403 }, { actorId: 'anonymous' });
```

For another destination, supply `{ enabled: true, write(batch, {actorId}), read?() }`
instead of the file adapter. The authenticated actor comes from the host, never the
browser. `/editor/diagnostics/config`, POST/GET `/editor/diagnostics` share the normal
editor authorization boundary. Disabled capture sends no event batches; configuration
is checked on each editor mount. An unavailable configuration endpoint costs at most
two seconds and does not prevent editing.

The browser receives the server switch automatically; `<PreparedBrowserEditor />`
needs no diagnostic props. Delivery flushes every 200ms, uses batches of at most 50
events / roughly 48KB, a 500-event queue, a five-second request timeout and three
exponential-backoff retries. A new event resumes delivery after retries are exhausted.
Overflow emits `diagnostics.dropped`; stable event IDs deduplicate retries in the file
sink's bounded recent-ID window. Events are redacted and bounded on both sides.
Guest stdout/stderr preserve UTF-8/partial lines with a 6KB pending-output bound.
Successful model response content, request bodies, and environment objects are not
collected. Failed provider bodies are bounded by bytes and time; proxy streaming is
not delayed by diagnostic processing. Sink failures do not stop workspace operations.

Pass the provided scope through `prepareBrowserEditorDependencies({ ...options, diagnostics: scope })`
to capture runtime/application checks, local input copies, each dependency install and
its stdout/stderr, tree capture, snapshot, bundle compression and cleanup. App-specific
cache/publication work can use `scope.record(name, data)` or `scope.stage(name, task)`.
Stages emit start, ready/failed and five-second waiting events. Manifest requests carry
the browser operation's `x-editor-run-id`, linking browser waits to host preparation.
Concurrent app preparation can record an owner run ID when sharing work.

Browser events also identify manifest fetch/decode/validation, cache hit/miss,
download/decompression sizes, `delivery.mode` (`bulk-tree` or `individual-files`),
bulk installation verification/install/readback timings, worker opening, service
readiness and process output. This distinguishes host preparation from browser startup.

The application's log command is just:

```ts
import { runEditorLogs } from '@kev-browser-agent-kit/opencode-chat/server';
await runEditorLogs({ directory: 'tmp/editor/diagnostics' });
```

It supports `--follow`, `--json`, `--run <ID-or-prefix>`, `--event <prefix>` and `--help`.
For example: `bun editor:logs --follow --event preparation`.
Shared reporter/scope primitives are exported from `/diagnostics` (also from workspace
`/diagnostics`); storage/reader helpers are exported from `/diagnostics/server`.

After local builds, reinstall consumers with
`bun install --force --frozen-lockfile --no-save` and restart their dev server.
The no-save flag avoids Bun 1.4 writing duplicate local-package keys during a forced
same-version reinstall. Rebuild order is workspace, chat, then reinstall the app.
