// One tab, four programs, all on the toolkit's runtime (a Web Worker each): the TODO app's Vite
// dev server, its backend, the OpenCode server, and the real OpenCode terminal client, which
// runs on a terminal of the runtime's kernel. This page holds the other end of that terminal
// and joins it to a ghostty-web display in the side panel (bytes both ways, and the size).
//
// Who talks to whom:
//   terminal client → OpenCode server   `http://127.0.0.1:<port>` in the guest: a socket of the
//                                       runtime's kernel; this page is not in between
//   OpenCode server → model             a plain cross-origin fetch from the tab to `?model=`;
//                                       no server of this page is involved
//   OpenCode server → api.openai.com    (a ChatGPT sign-in) the runtime's own TLS and HTTP through
//                                       a TCP relay, `?tunnel=`, which carries ciphertext only
//   app in the frame → its `/api`       a third guest program (todo-api.ts), through the service worker
//
// The page is a directory of static files: every URL is relative to the page, and the
// service worker (sw.ts) gives the responses the headers a server would have sent.
//
//   ?model=<base URL>    an OpenAI Responses API. Default: the build's MODEL_URL, else this host, port 4311 (mock-model.ts)
//   ?modelId=<id>        the model id sent in requests. Default `scripted`
//   ?tunnel=<wss URL>    a TCP relay (packages/relay/tcp-relay-main.ts) for the hosts that answer without CORS headers.
//                        Default: the build's TUNNEL_URL, else none; `0` for none
//   ?clientLog=debug     the client logs every level to its file in the guest (/tmp/opencode-client/tui.log)
//   ?reset=1             first forget this browser's workspace (source edits, sessions) and the client's saved state
import { installDerived, installSource, type BootRuntime, type EditorManifest, type RuntimeHost, type RuntimeProcess, type RuntimeTerminal, type TerminalSize } from '@kkrausse/browser-agent-toolkit/browser'
import { clientEntry, clientLaunch, clientLog, installClient } from './client'
import { installDiag } from './diag'
import { isolate } from './isolate'
import { installServerConfig, serverHealthy, serverLaunch, toLaunch, workspace, type ModelEndpoint } from './opencode'
import { installPanel } from './panel'
import { watchSignIn } from './signin'

/** What `display/display.js` exports (`packages/terminal/display.ts`, bundled by `display.ts` here): the terminal display alone. */
interface DisplayModule {
  mountDisplay(options: {
    container: HTMLElement
    wasmUrl: string
    fontSize?: number
    ctrlVPaste?: boolean
    onInput(data: string): void
    onResize(size: TerminalSize): void
  }): Promise<Display>
}
interface Display {
  write(data: Uint8Array | string): void
  size(): Required<TerminalSize>
  screen(): string[]
  focus(): void
}
/** The side panel's terminal: the display, the client's process, and the screen as text (for checks and diagnostics). */
interface Mounted {
  display: Display
  client: RuntimeTerminal
  screen(): string[]
}
declare global { interface Window { batTerminal: { runtime?: RuntimeHost; terminal?: Mounted; model?: ModelEndpoint; log: string[] } } }

// Everything is beside the page, wherever that is served.
const here = new URL('.', document.baseURI).href
const assets = new URL('display/', here).href
const manifestUrl = new URL('editor/manifest.json', here).href
const workerUrl = new URL('sw.js', here).href
/** The TODO app's own backend, as a guest program: where it is written and where it listens. */
const api = { script: '/tmp/todo-api.mjs', port: 3001, store: `${workspace}/.server/todos.json` }
// Set when the page is built (`MODEL_URL=… bun run build`), for a page published away from its mock.
const builtModel = process.env.MODEL_URL || undefined
const builtTunnel = process.env.TUNNEL_URL || undefined

// OpenAI's signing keys, which the server reads to check the identity token of a ChatGPT sign-in.
// That document is served without CORS headers. With a tunnel the server reads the real one
// through it; without, the build ships a copy (build.ts) and the request is answered with that.
const openAiKeys = 'https://auth.openai.com/.well-known/jwks.json'
// What goes through the tunnel when there is one: the model API of a ChatGPT sign-in, whose
// answers carry no CORS headers, and the keys above. The token exchange at auth.openai.com
// allows any origin and stays with the browser's fetch. OpenCode's own hosted models
// (opencode.ai/zen), which the server calls with no sign-in, refuse a browser's preflight (404).
const tunnelled = ['api.openai.com', 'https://auth.openai.com/.well-known/', 'opencode.ai']

const params = new URLSearchParams(location.search)
// `?reset=1` is taken out of the address at once and remembered for this start only: the page
// may reload itself before it gets that far (isolate.ts), and a later reload must not reset again.
const resetKey = 'terminal-app-reset'
if (params.get('reset') === '1') {
  try { sessionStorage.setItem(resetKey, '1') } catch { /* no storage: no reset */ }
  params.delete('reset')
  history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`)
}
const model: ModelEndpoint = {
  baseURL: params.get('model') ?? builtModel ?? `${location.protocol}//${location.hostname}:4311/v1`,
  id: params.get('modelId') ?? 'scripted',
  apiKey: 'not-a-key',
}

const givenTunnel = params.get('tunnel') ?? builtTunnel
const tunnel = givenTunnel && givenTunnel !== '0' && /^wss?:$/.test(URL.parse(givenTunnel)?.protocol ?? '') ? { url: givenTunnel, to: tunnelled } : undefined

const status = document.querySelector<HTMLPreElement>('#status')!
const frame = document.querySelector<HTMLIFrameElement>('#app')!
const logPane = document.querySelector<HTMLPreElement>('#log pre')!
const diag = installDiag(params, builtModel && new URL('/diag', builtModel).href)
const say = (text: string, error = false) => { status.textContent = text; status.classList.toggle('error', error); diag.event(error ? 'failed' : 'stage', text) }
window.batTerminal = { log: [], model }
document.querySelector('#title')!.textContent = `OpenCode · model ${model.id} at ${new URL(model.baseURL).host}${tunnel ? ` · tunnel ${new URL(tunnel.url).host}` : ''}`
const panel = installPanel({ onOpen: () => window.batTerminal.terminal?.display.focus() })
// Ctrl+Tab and Ctrl+Shift+Tab switch browser tabs. The terminal would take them (and cancel
// the browser's handling) like any other key, so they are kept from it here.
for (const type of ['keydown', 'keyup'] as const) {
  window.addEventListener(type, event => { if (event.ctrlKey && event.key === 'Tab') event.stopImmediatePropagation() }, true)
}

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
  // The display's code loads while the runtime boots. A variable, so the bundler leaves the import alone.
  const displayUrl = assets + 'display.js'
  const displayModule = import(displayUrl) as Promise<DisplayModule>
  void displayModule.catch(() => {})
  // Guest programs that are files of this page: fetched while the runtime boots.
  const script = (name: string) => {
    const bytes = fetch(new URL(name, here)).then(async response => {
      if (!response.ok) throw Error(`${name} answered HTTP ${response.status}`)
      return new Uint8Array(await response.arrayBuffer())
    })
    void bytes.catch(() => {})
    return bytes
  }
  const apiScript = script('todo-api.js'), tapScript = script('client-tap.js')

  say('Loading…')
  const response = await fetch(manifestUrl, { cache: 'no-store' })
  if (!response.ok) throw Error(`No prepared editor: ${manifestUrl} answered HTTP ${response.status}`)
  const manifest = await response.json() as EditorManifest
  if (!manifest.launch.agent) throw Error('The prepared directory has no OpenCode server')
  const runtimeModule = await import(new URL(manifest.runtime?.entry ?? 'runtime/host.js', manifestUrl).href) as { bootRuntime: BootRuntime; resetWorkspace(options: { manifestUrl: string }): Promise<void> }
  if (sessionStorage.getItem(resetKey)) {
    sessionStorage.removeItem(resetKey)
    await runtimeModule.resetWorkspace({ manifestUrl })
    // What an earlier build of this page kept for the client (wasm-term's IndexedDB); the client's files are in the workspace now.
    for (const database of await indexedDB.databases()) if (database.name) indexedDB.deleteDatabase(database.name)
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
  if (!runtime.spawnTerminal) throw Error('This runtime has no terminals (spawnTerminal)')
  if (!await runtime.fs.stat(clientEntry).then(() => true, () => false)) throw Error(`The prepared image has no OpenCode client (${clientEntry}): build ports/opencode for Node and prepare again`)
  // The page watches for a sign-in that waits on a loopback redirect (signin.ts).
  await installClient(runtime.fs, await tapScript, watchSignIn(() => window.batTerminal.runtime, log))
  log(`[page] model endpoint: ${model.baseURL} (model ${model.id}), fetched by this tab directly`)
  if (tunnel) log(`[page] tunnel: ${tunnel.to.join(', ')} through the relay at ${new URL(tunnel.url).host}, with TLS in this tab`)

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
    runtime.spawn(serverLaunch(agent, password, model, tunnel ? { tunnel } : { fetchMap: { [openAiKeys]: new URL('openai-jwks.json', here).href } })),
    runtime.spawn({ argv: ['node', api.script], cwd: workspace, env: { PATH: '/bin', PORT: String(api.port), TODO_STORE: api.store }, programs: [] }),
  ])
  follow('app', appProcess, false)
  follow('api', apiProcess, true)
  follow('opencode', serverProcess, true)
  const appUp = app.ready(lifetime.signal).then(() => { frame.src = app.url })
  const serverUp = server.ready(lifetime.signal).then(() => serverHealthy(server, authorization, lifetime.signal))
  void Promise.allSettled([appUp, serverUp]).then(() => runtime.started?.())
  await serverUp

  // Client and server are the same version. The display is mounted first: the client starts at its size.
  let client: RuntimeTerminal | undefined
  const display = await (await displayModule).mountDisplay({
    container: document.querySelector<HTMLDivElement>('#terminal')!,
    wasmUrl: assets + 'ghostty-vt.wasm',
    fontSize: 13,
    // The client has no clipboard of its own in the guest: ctrl+v is the browser's paste, which
    // reaches it as (bracketed) input. What it copies comes out as OSC 52, which the display serves.
    ctrlVPaste: true,
    onInput: data => client?.write(data),
    onResize: size => client?.resize(size),
  })
  const started = performance.now()
  const launch = clientLaunch(agent.port, password)
  // `?clientLog=debug`: the client logs every level to its file, not only warnings and errors.
  if (params.get('clientLog') === 'debug') launch.env = { ...launch.env, OPENCODE_TUI_DEBUG: '1' }
  let first = true
  client = await runtime.spawnTerminal(launch, { ...display.size(), onOutput: data => {
    if (first) { first = false; log(`[page] the client's first output came ${Math.round(performance.now() - started)} ms after its start`) }
    display.write(data)
  } })
  log(`[page] OpenCode client started on a terminal of the runtime (pid ${client.pid}, ${display.size().cols}x${display.size().rows})`)
  void client.exited.then(exit => {
    log(`[client] exited (code ${exit.code}, signal ${exit.signal ?? 'none'}) after ${Math.round(performance.now() - started)} ms`)
    // Its stderr was the terminal; what it logged to its file says why it ended.
    void runtime.fs.readFile(clientLog).then(bytes => { for (const line of new TextDecoder().decode(bytes).trim().split('\n').slice(-20)) if (line) log(`[client log] ${line.slice(0, 600)}`) }, () => {})
    display.write(`\r\n\x1b[0m\x1b[2m[process ended: ${exit.signal ? `killed by ${exit.signal}` : `exit code ${exit.code}`}]\x1b[0m\r\n`)
  })
  window.batTerminal.terminal = { display, client, screen: display.screen }
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
