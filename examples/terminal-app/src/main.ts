// One tab, three programs. The TODO app's Vite dev server and the OpenCode server run in
// Web Workers on the toolkit's runtime; the real OpenCode terminal client runs in another
// Worker on wasm-term's pty machine and draws into a ghostty-web terminal in the side panel.
//
// Who talks to whom:
//   terminal client → OpenCode server   through this page (wasm-term relays the client's
//                                       fetches here; `endpoint(port).fetch` reaches the server)
//   OpenCode server → model             a plain cross-origin fetch from the tab to `?model=`;
//                                       no server of this page is involved
//   app in the frame → its `/api`       a third guest program (todo-api.ts), through the service worker
//
// The page is a directory of static files: every URL is relative to the page, and the
// service worker (sw.ts) gives the responses the headers a server would have sent.
//
//   ?model=<base URL>    an OpenAI Responses API. Default: the build's MODEL_URL, else this host, port 4311 (mock-model.ts)
//   ?modelId=<id>        the model id sent in requests. Default `scripted`
//   ?reset=1             first forget this browser's workspace (source edits, sessions) and the client's saved state
import { installDerived, installSource, type BootRuntime, type EditorManifest, type RuntimeHost, type RuntimeProcess } from '@kkrausse/browser-agent-toolkit/browser'
import { olderServer } from './compat'
import { installDiag } from './diag'
import { isolate } from './isolate'
import { installServerConfig, serverHealthy, serverLaunch, toLaunch, workspace, type ModelEndpoint } from './opencode'
import { installPanel } from './panel'

/** What `/wasm-term/embed.js` exports (wasm-term's `web/embed.ts`, bundled by `wasm-term.ts`). */
interface WasmTerm {
  mountTerminal(options: {
    container: HTMLElement
    assets: string
    guest: string
    env?: Record<string, string>
    fontSize?: number
    persist?: { namespace: string; roots: string[]; exclude?: string[] }
    pageFetch?: {
      prefixes: string[]
      fetch(url: string, init: { method: string; headers: [string, string][]; body: Uint8Array | null; signal: AbortSignal }): Promise<Response>
    }
  }): Promise<Mounted>
}
interface Mounted {
  terminal: { cols: number; rows: number; focus(): void }
  program: { write(data: string): void }
  screen(): string[]
}
declare global { interface Window { batTerminal: { runtime?: RuntimeHost; terminal?: Mounted; model?: ModelEndpoint; log: string[] } } }

// The address the client is given. Nothing listens there: requests under it are relayed to
// this page (wasm-term's page-fetch), which hands them to the OpenCode server in the tab.
const inTabServer = 'http://opencode.in-tab'
// Everything is beside the page, wherever that is served.
const here = new URL('.', document.baseURI).href
const assets = new URL('wasm-term/', here).href
const manifestUrl = new URL('editor/manifest.json', here).href
const workerUrl = new URL('sw.js', here).href
/** The TODO app's own backend, as a guest program: where it is written and where it listens. */
const api = { script: '/tmp/todo-api.mjs', port: 3001, store: `${workspace}/.server/todos.json` }
// Set when the page is built (`MODEL_URL=… bun run build`), for a page published away from its mock.
const builtModel = process.env.MODEL_URL || undefined

const params = new URLSearchParams(location.search)
const model: ModelEndpoint = {
  baseURL: params.get('model') ?? builtModel ?? `${location.protocol}//${location.hostname}:4311/v1`,
  id: params.get('modelId') ?? 'scripted',
  apiKey: 'not-a-key',
}

const status = document.querySelector<HTMLPreElement>('#status')!
const frame = document.querySelector<HTMLIFrameElement>('#app')!
const logPane = document.querySelector<HTMLPreElement>('#log pre')!
const diag = installDiag(params, builtModel && new URL('/diag', builtModel).href)
const say = (text: string, error = false) => { status.textContent = text; status.classList.toggle('error', error); diag.event(error ? 'failed' : 'stage', text) }
window.batTerminal = { log: [], model }
document.querySelector('#title')!.textContent = `OpenCode · model ${model.id} at ${new URL(model.baseURL).host}`
const panel = installPanel({ onOpen: () => window.batTerminal.terminal?.terminal.focus() })

function log(line: string) {
  window.batTerminal.log.push(line)
  diag.event('log', line.slice(0, 600))
  if (window.batTerminal.log.length > 2000) window.batTerminal.log.shift()
  const pinned = logPane.scrollTop + logPane.clientHeight >= logPane.scrollHeight - 4
  logPane.append(line + '\n')
  if (pinned) logPane.scrollTop = logPane.scrollHeight
}
/** A process's output as lines, until it ends. */
async function pump(stream: ReadableStream<Uint8Array>, line: (text: string) => void) {
  const reader = stream.getReader(), decoder = new TextDecoder()
  let rest = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      rest += decoder.decode(value, { stream: !done })
      const lines = rest.split('\n')
      rest = lines.pop()!
      for (const text of lines) if (text.trim()) line(text.slice(0, 2000))
      if (done) break
    }
  } catch { /* the runtime closed */ }
}
function follow(name: string, process: RuntimeProcess, show: boolean) {
  if (show) { void pump(process.stdout, text => log(`[${name}] ${text}`)); void pump(process.stderr, text => log(`[${name} stderr] ${text}`)) }
  void process.exited.then(exit => log(`[${name}] exited (code ${exit.code}, signal ${exit.signal ?? 'none'})`))
}

async function main() {
  // Returns only in an isolated page that the service worker controls (it reloads once to get there).
  await isolate(workerUrl, here, (kind, data) => diag.event(kind, data))
  // The terminal's code loads while the runtime boots. A variable, so the bundler leaves the import alone.
  const embed = assets + 'embed.js'
  const wasmTerm = import(embed) as Promise<WasmTerm>
  void wasmTerm.catch(() => {})
  const apiScript = fetch(new URL('todo-api.js', here)).then(async response => {
    if (!response.ok) throw Error(`todo-api.js answered HTTP ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  })
  void apiScript.catch(() => {})

  say('Loading…')
  const response = await fetch(manifestUrl, { cache: 'no-store' })
  if (!response.ok) throw Error(`No prepared editor: ${manifestUrl} answered HTTP ${response.status}`)
  const manifest = await response.json() as EditorManifest
  if (!manifest.launch.agent) throw Error('The prepared directory has no OpenCode server')
  const runtimeModule = await import(new URL(manifest.runtime?.entry ?? 'runtime/host.js', manifestUrl).href) as { bootRuntime: BootRuntime; resetWorkspace(options: { manifestUrl: string }): Promise<void> }
  if (params.get('reset') === '1') {
    await runtimeModule.resetWorkspace({ manifestUrl })
    // The terminal client's files (wasm-term keeps them in IndexedDB); this origin has no other database.
    for (const database of await indexedDB.databases()) if (database.name) indexedDB.deleteDatabase(database.name)
    params.delete('reset')
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`)
  }
  const { bootRuntime } = runtimeModule
  say('Opening the workspace in this browser…')
  const lifetime = new AbortController()
  // One worker for the whole directory: it is at the page's level, so no server has to allow its scope.
  const runtime = await bootRuntime({ manifestUrl, manifest, signal: lifetime.signal, serviceWorker: { url: workerUrl, scope: here } }).catch(error => {
    throw (error as { code?: string })?.code === 'STORAGE_BUSY' ? Error('This workspace is already open in another tab or window.') : error
  })
  window.batTerminal.runtime = runtime
  window.addEventListener('pagehide', () => void runtime.close().catch(() => {}))
  const source = await installSource(runtime.fs, manifest.project)
  log(`[page] ${source.preserved ? 'kept the workspace already in this browser' : `installed ${source.installed} source files`}`)
  await installDerived(runtime.fs, manifest, manifestUrl)
  await installServerConfig(runtime.fs, model)
  log(`[page] model endpoint: ${model.baseURL} (model ${model.id}), fetched by this tab directly`)

  // Both programs start at once; each is its own Worker.
  say('Starting the app and the OpenCode server…')
  const preview = manifest.launch.preview, agent = manifest.launch.agent
  const app = runtime.endpoint(preview.port), server = runtime.endpoint(agent.port)
  // The app calls `/api` as on its own server; here that server is a guest program too.
  runtime.setGuestPaths!(preview.port, { '/api': api.port })
  await runtime.fs.writeFile(api.script, await apiScript)
  // A fresh credential per start; it stays in this page and the guest.
  const password = crypto.randomUUID() + crypto.randomUUID()
  const authorization = 'Basic ' + btoa('opencode:' + password)
  const [appProcess, serverProcess, apiProcess] = await Promise.all([
    // The dev server's base is the frame's path, which depends on where this page is served.
    runtime.spawn(toLaunch(preview, { BROWSER_AGENT_PORT: String(preview.port), BROWSER_AGENT_BASE: new URL(app.url).pathname })),
    runtime.spawn(serverLaunch(agent, password, model)),
    runtime.spawn({ argv: ['node', api.script], cwd: workspace, env: { PATH: '/bin', PORT: String(api.port), TODO_STORE: api.store }, programs: [] }),
  ])
  follow('app', appProcess, false)
  follow('api', apiProcess, true)
  follow('opencode', serverProcess, true)
  const appUp = app.ready(lifetime.signal).then(() => { frame.src = app.url })
  const serverUp = server.ready(lifetime.signal).then(() => serverHealthy(server, authorization, lifetime.signal))
  void Promise.allSettled([appUp, serverUp]).then(() => runtime.started?.())
  await serverUp

  // The client is newer than the server (compat.ts); the server's credential is added here.
  const toServer = olderServer((path, init) => server.fetch(path, {
    method: init.method,
    headers: [...init.headers.filter(([name]) => name.toLowerCase() !== 'authorization'), ['authorization', authorization]],
    body: init.body as BodyInit | null,
    signal: init.signal,
  }))
  const { mountTerminal } = await wasmTerm
  window.batTerminal.terminal = await mountTerminal({
    container: document.querySelector<HTMLDivElement>('#terminal')!,
    assets,
    guest: 'opencode',
    fontSize: 13,
    env: {
      OPENCODE_SERVER_URL: inTabServer,
      // The client insists on Basic auth; the page replaces what it sends with the real credential.
      OPENCODE_SERVER_PASSWORD: 'in-tab',
      OPENCODE_DIRECTORY: workspace,
    },
    // The client's own settings, prompt history and open tabs (IndexedDB), as on wasm-term's page.
    persist: { namespace: 'opencode', roots: ['/home/user/.config/opencode', '/home/user/.local/state/opencode'], exclude: ['/locks/'] },
    pageFetch: {
      prefixes: [inTabServer],
      fetch: (url, init) => {
        const target = new URL(url)
        return toServer(target.pathname + target.search, init)
      },
    },
  })
  status.remove()
  diag.event('stage', 'terminal mounted')
  diag.watchScreen(() => window.batTerminal.terminal!.screen())
  if (!panel.open) (document.activeElement as HTMLElement | null)?.blur()
  await appUp
}

main().catch(error => {
  console.error(error)
  say(`Could not start: ${error instanceof Error ? error.message : String(error)}`, true)
  panel.setOpen(true)
})
