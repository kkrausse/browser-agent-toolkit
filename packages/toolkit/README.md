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
})
```

Runs the Rust CLI `bat-prepare app` (found through `$BAT_PREPARE`, a cargo `target` directory
above, or PATH), which packs the dependency image and writes `manifest.json`. Files derived from the
project at prepare time (Vite's dependency-optimizer cache) go to `derived-<hash>.json`
beside it; the browser installs that bundle only when it or the image changed, replacing
the directories it owns.

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
import { openEditor } from '@kkrausse/browser-agent-toolkit/browser'

const editor = await openEditor({ onEvent: event => console.debug(event) })
await editor.ready                                  // preview, agent and chat are up
await editor.chat.send({ text: 'Add a dark theme' })
console.log(editor.snapshot().timings)              // ms per startup step
await editor.close()
```

`resetWorkspace({ base? })` deletes this browser's copy of the workspace (edits, sessions,
caches; not the dependency image); it rejects while the editor is open in any tab.

`Editor` also has `fs`, `preview` and `agent` (`{ endpoint, ready, stop }`), `restartPreview()`,
`restartAgent()`, `flush()`, `sessions.export()` / `sessions.import()`, `subscribe()`.

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
([src/runtime-host.ts](src/runtime-host.ts)). Until that runtime is plugged in, `./fake`
(`bootFakeRuntime`, passed as `openEditor({ boot })`) and `./fake/server` (`createFakeHost`)
back the same interface with native processes behind a dev server. It is not a sandbox:
loopback and development only. See `examples/todo-app`.
