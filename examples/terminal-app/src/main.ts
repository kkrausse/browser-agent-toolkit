// One tab, three programs: the app's Vite dev server and the OpenCode server run in Web
// Workers on the toolkit's runtime; the real OpenCode terminal client runs in another Worker
// on wasm-term's pty machine and draws into a ghostty-web terminal. The client's HTTP
// requests (JSON calls and its one event stream) never touch the network: the page answers
// them from the in-tab server.
import { openEditor, type Editor, type EditorEvent } from '@kkrausse/browser-agent-toolkit/browser'

/** What `/wasm-term/embed.js` exports (wasm-term's `web/embed.ts`, bundled by `wasm-term.ts`). */
interface WasmTerm {
  mountTerminal(options: {
    container: HTMLElement
    assets: string
    guest: string
    env?: Record<string, string>
    persist?: { namespace: string; roots: string[]; exclude?: string[] }
    pageFetch?: {
      prefixes: string[]
      fetch(url: string, init: { method: string; headers: [string, string][]; body: Uint8Array | null; signal: AbortSignal }): Promise<Response>
    }
  }): Promise<Mounted>
}
interface Mounted {
  program: { write(data: string): void; exited: Promise<{ code: number; error?: string }> }
  screen(): string[]
  dispose(): void
}
declare global { interface Window { batTerminal: { editor?: Editor; terminal?: Mounted; log: string[] } } }

// The address the client is given. Nothing listens there: requests under it are relayed to
// the page (wasm-term's page-fetch), which hands them to the OpenCode server in this tab.
const inTabServer = 'http://opencode.in-tab'
const assets = '/wasm-term/'

const status = document.querySelector<HTMLPreElement>('#status')!
const frame = document.querySelector<HTMLIFrameElement>('#preview')!
const logPane = document.querySelector<HTMLPreElement>('#log pre')!
const say = (text: string, error = false) => { status.textContent = text; status.classList.toggle('error', error) }
window.batTerminal = { log: [] }

function onEvent(event: EditorEvent) {
  if (event.type === 'state') { if (status.isConnected && !status.classList.contains('error')) say(event.snapshot.error ?? event.snapshot.message, !!event.snapshot.error); return }
  if (event.type !== 'log' || event.source === 'preview') return
  const line = `[${event.source}] ${event.line}`
  window.batTerminal.log.push(line)
  const pinned = logPane.scrollTop + logPane.clientHeight >= logPane.scrollHeight - 4
  logPane.append(line + '\n')
  if (pinned) logPane.scrollTop = logPane.scrollHeight
}

async function main() {
  if (!crossOriginIsolated) throw Error('This page is not cross-origin isolated (COOP same-origin, COEP require-corp).')
  // The terminal's code loads while the runtime boots. A variable, so the bundler leaves the import alone.
  const embed = assets + 'embed.js'
  const wasmTerm = import(embed) as Promise<WasmTerm>
  void wasmTerm.catch(() => {})
  // No chat controller: the terminal client is the only OpenCode client on this page.
  const editor = await openEditor({ chat: { attach: false }, onEvent })
  window.batTerminal.editor = editor
  window.addEventListener('pagehide', () => void editor.close().catch(() => {}))
  editor.setHostPaths(['/api'])

  let shown = false
  const showPreview = () => {
    const state = editor.snapshot().preview
    if (shown || (state !== 'listening' && state !== 'ready')) return
    shown = true
    frame.src = editor.preview.endpoint.url
  }
  editor.subscribe(showPreview)
  showPreview()

  // `agent.ready`: the server answers, its plugins are active and its model is configured.
  await editor.agent.ready
  const { mountTerminal } = await wasmTerm
  window.batTerminal.terminal = await mountTerminal({
    container: document.querySelector<HTMLDivElement>('#terminal')!,
    assets,
    guest: 'opencode',
    env: {
      OPENCODE_SERVER_URL: inTabServer,
      // The client insists on sending Basic auth; the page replaces it with the real,
      // per-start credential (`editor.agent.endpoint.fetch`), which never leaves the page.
      OPENCODE_SERVER_PASSWORD: 'in-tab',
      OPENCODE_DIRECTORY: '/workspace',
    },
    // The client's own settings, prompt history and open tabs (IndexedDB), as on wasm-term's page.
    persist: { namespace: 'opencode', roots: ['/home/user/.config/opencode', '/home/user/.local/state/opencode'], exclude: ['/locks/'] },
    pageFetch: {
      prefixes: [inTabServer],
      fetch(url, init) {
        const target = new URL(url)
        return editor.agent.endpoint.fetch(target.pathname + target.search, {
          method: init.method,
          headers: init.headers.filter(([name]) => name.toLowerCase() !== 'authorization'),
          body: init.body as BodyInit | null,
          signal: init.signal,
        })
      },
    },
  })
  status.remove()
}

main().catch(error => {
  console.error(error)
  say(`Could not start: ${error instanceof Error ? error.message : String(error)}`, true)
})
