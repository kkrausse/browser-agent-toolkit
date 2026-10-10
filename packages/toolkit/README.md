# @kkrausse/browser-agent-toolkit

Embed a coding agent in a web app: the app's own dev server and an OpenCode 2.0.3 server run
inside the visitor's browser tab, and a chat panel edits the app's source there. One package,
five entry points. Build with `bun run build` (output in `dist/`).

## `./prepare` (build time)

```ts
import { prepare } from '@kkrausse/browser-agent-toolkit/prepare'

await prepare({
  appRoot: import.meta.dirname,
  outDir: '.editor/prepared',
  source: ['src', 'vite.config.ts', 'package.json'],   // what the agent may edit
  openCodeDir: '.runtime/opencode-2.0.3',              // the pinned server; default $BAT_OPENCODE_DIR
  startupModules: 'startup-modules.json',              // optional recording, see below
  startupOrder: 'editor-startup-order.txt',            // optional recording, see below
})
```

Runs the Rust CLI `bat-prepare app` (found through `bin`, `$BAT_PREPARE`, a cargo `target`
directory above, or PATH) and copies the runtime's files (`runtimeDir`, `$BAT_RUNTIME_DIR`,
or `runtime/dist` of the repository) to `<outDir>/runtime/`. The output is static files:

| File | What |
| --- | --- |
| `manifest.json` | launches, editable source, and the names of everything below; fetched `no-store` |
| `image-<hash>.batimg` (+ `.zst`, `.sums`) | the dependency image: the app's lockfile packages, pruned, each module already compiled for the loader. The `.zst` copy is what browsers download (`compressionLevel`, default 9); `.sums` holds a SHA-256 per MiB, checked before a block is written |
| `manifest.layers[]`: a second, small image | packages that are not from the lockfile (workspace members, `file:` directories), mounted over the first, so that rebuilding one of them does not change the large image's name |
| `program-<name>-<hash>.js` | modules as one script the browser keeps compiled between visits: the OpenCode server, and each launch's start-up modules when `startupModules` is given |
| `derived-<hash>.json` | files derived from the project at prepare time (Vite's dependency-optimizer cache); the browser installs it only when it or the image changed, replacing the directories it owns |
| `runtime/` | `host.js`, the worker scripts, the Wasm files and `sw.js` |

Two optional inputs are recordings of a real start, and only cost speed when missing or
stale (paths that no longer exist are skipped):

- `startupModules`: JSON `{ preview?: string[], agent?: string[] }` of guest paths each
  program had loaded once it was up (the example's comes from
  `bench/startup/run.ts --trace --record-modules`).
- `startupOrder`: an order file (`bat-prepare order`, from `bench/first-open/trace.ts`).
  The file bodies a start reads are laid out first in the image, so a visitor's first open
  starts when the head of the image has arrived and the rest downloads in the background.

Also: `preview` (changes to the dev-server launch, default Vite on port 5173), `files`
(extra project files), `manifestOnly` (no image, for the development fake).

## `./server` (serve time)

```ts
import { createEditorHandler } from '@kkrausse/browser-agent-toolkit/server'

const editor = createEditorHandler({
  preparedDir: '.editor/prepared',
  providers: { opencode: { baseURL: 'https://opencode.ai/zen/v1', headers: { authorization: `Bearer ${process.env.MODEL_KEY}` } } },
})

Bun.serve({ async fetch(request) {
  if (await editor.matches(request)) return mayEdit(request) ? editor.fetch(request) : new Response('Forbidden', { status: 403 })
  const response = await app(request)
  for (const [name, value] of Object.entries(editor.headers)) response.headers.set(name, value)
  return response
} })
```

The handler serves the prepared directory and proxies model requests; the provider key stays
on the server. Who may edit is the app's decision, made before `editor.fetch`.

## `./browser`

```ts
import { openEditor, preloadEditor } from '@kkrausse/browser-agent-toolkit/browser'

preloadEditor()                                     // optional, when the button is rendered
const editor = await openEditor({ onEvent: event => console.debug(event) })
await editor.ready                                  // preview, agent and chat are up
await editor.chat.send({ text: 'Add a dark theme' })
console.log(editor.snapshot().timings)              // ms per startup step
await editor.close()
```

`openEditor` resolves when the runtime is booted and both programs have been spawned (they
start at the same time); `editor.ready` when the preview answers and the chat is attached.
A second tab on the same origin rejects with "This workspace is already open in another tab
or window…".

`preloadEditor({ base? })` fetches the manifest, imports the runtime module and compiles
the kernel, so the open itself does not pay for them. It takes no lock, writes nothing and
starts no program, so it is safe on a page whose visitor never opens the editor.

`resetWorkspace({ base? })` deletes this browser's copy of the workspace (edits, sessions,
caches; not the dependency image); it rejects while the editor is open in any tab.

`Editor` also has `fs`, `preview` and `agent` (`{ endpoint, ready, stop }`), `restartPreview()`,
`restartAgent()`, `setHostPaths()`, `flush()`, `sessions.export()` / `sessions.import()`,
`mark(name)`, `subscribe()` and `snapshot()` (status, message, per-step timings, log).
Steps, in `editorSteps`: `manifest`, `boot`, `source`, `preview.spawn`, `preview.listening`,
`preview.ready`, `agent.spawn`, `agent.ready`, `chat.ready`.

## `./react`

```tsx
import { ChatView, EditorPreview, useEditor } from '@kkrausse/browser-agent-toolkit/react'
import '@kkrausse/browser-agent-toolkit/styles.css'

function Editor() {
  const { editor, snapshot, retry } = useEditor()
  if (!editor) return <p>{snapshot.error ?? snapshot.message}</p>
  return <>
    <EditorPreview editor={editor} hostPaths={['/api']} isReady={frame => !!frame.contentDocument?.querySelector('main')} />
    <ChatView controller={editor.chat} />
  </>
}
```

## `./vite`

```ts
import { browserEditor } from '@kkrausse/browser-agent-toolkit/vite'

export default defineConfig({
  plugins: [react(), browserEditor({ module: 'src/editing.tsx', privateEntry: 'src/editor-panel.tsx' })],
})
```

In the guest (`BROWSER_AGENT_GUEST=1`) it sets `base` to `/preview/<port>/` and the cache
directory, and replaces `module` with a component that renders nothing, so the preview does
not offer an editor inside the editor. In a host build it lists the chunks only
`privateEntry` reaches in `editor-assets.json`; pass `clientDir` to the server handler and
they are served only through it. `previewBase()` is the matching router basename.

## Runtime interface and the development fake

Everything here talks to the browser runtime through `RuntimeHost`
([src/runtime-host.ts](src/runtime-host.ts)): `fs`, `spawn(launch)`, `endpoint(port)`,
`setHostPaths`, `hostOrigin`, `flush`, `close`, and the optional `started()`, which the
toolkit calls once the preview and the agent are up (or have failed) so that the runtime
may use the network for what it held back for them: the rest of the image download on a
first open. The manifest names the module that exports `bootRuntime` (default
`runtime/host.js`, built from `runtime/` in this repository); a `Launch` may name prepared
program scripts (`programs`) the runtime loads before the entry runs.

`./fake` (`bootFakeRuntime`, passed as `openEditor({ boot })`) and `./fake/server`
(`createFakeHost`) back the same interface with native processes behind a dev server, for
working on the UI without the runtime. It is not a sandbox: loopback and development only.
See `examples/todo-app` (`bun run editor:fake`).

## Limits

Chrome only so far; the hosting pages must be cross-origin isolated (`editor.headers`).
The agent's tools are read, edit, grep, glob and `runJavascript`; OpenCode's shell tool is
not enabled and nothing can be installed inside the guest. Third-party notices:
[NOTICES.md](NOTICES.md).
