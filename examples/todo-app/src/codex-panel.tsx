import { useEffect, useRef, useState } from 'react'
// The code is `/codex/terminal.js` (codex/terminal.ts, bundled by codex.ts), fetched when Codex is first chosen.
import type { CodexModule, CodexOptions, MountedCodex, PageKernel } from './codex-api'

export type CodexKernel = PageKernel
/** From the server (`/editing-policy`): present when `bun codex.ts` has been run. */
export interface CodexPolicy { tcpRelay?: string }
/** How the editor panel stops codex before it closes the runtime under it. */
export interface CodexHandle { dispose?(): void }

declare global { interface Window { __codex?: MountedCodex & { timings: Record<string, number> } } }

const load = () => import(/* @vite-ignore */ `${location.origin}/codex/terminal.js`) as Promise<CodexModule>
const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(0)} MB`

/** Page parameters, the same names the static codex page uses where it has them:
 * `codex-backend=mock` (wasm-term's scripted model, for tests; default `openai`), `codex-mock=<url>`,
 * `codex-net=direct|tunnel`, `tcp=wss://host/tcp` (a relay; implies `tunnel`). */
function settings(policy: CodexPolicy): Pick<CodexOptions, 'backend' | 'net' | 'tcpRelay' | 'mockUrl'> {
  const query = new URLSearchParams(location.search)
  const tcpRelay = query.get('tcp') ?? policy.tcpRelay
  const backend = query.get('codex-backend')
  return {
    backend: backend === 'mock' || backend === 'mock-auth' ? backend : 'openai',
    net: (query.get('codex-net') ?? (tcpRelay ? 'tunnel' : 'direct')) === 'tunnel' && tcpRelay ? 'tunnel' : 'direct',
    tcpRelay,
    mockUrl: query.get('codex-mock') ?? undefined,
  }
}

/** The codex TUI in a terminal, working in `/workspace` of the editor's runtime. Mounted on first use and kept
 * (hidden) while the other agent is shown; `active` gives it the keyboard. */
export default function CodexPanel({ kernel, policy, active, handle, onPrompt }: {
  kernel: CodexKernel
  policy: CodexPolicy
  active: boolean
  handle: CodexHandle
  /** The TUI is drawn and waits for input: ms since this panel started loading. */
  onPrompt?(ms: number): void
}) {
  const container = useRef<HTMLDivElement>(null)
  const terminal = useRef<MountedCodex>(undefined)
  const [run, setRun] = useState(0)
  const [status, setStatus] = useState('Loading codex…')
  const [notice, setNotice] = useState('')
  const [signedIn, setSignedIn] = useState<boolean>()
  const chosen = settings(policy)

  useEffect(() => {
    const target = container.current
    if (!target) return
    let current = true
    const started = performance.now()
    const timings: Record<string, number> = {}
    setStatus('Loading codex…')
    void (async () => {
      const module = await load()
      void module.hasCodexCredentials().then(value => { if (current) setSignedIn(value) })
      const mounted = await module.mountCodex({
        container: target, assets: '/codex/', kernel, workspace: '/workspace', ...chosen,
        onLoad({ phase, loaded, total }) {
          if (!current) return
          if (phase === 'download') setStatus(total ? `Loading codex: ${megabytes(loaded)} of ${megabytes(total)}` : `Loading codex: ${megabytes(loaded)}`)
          else if (phase === 'compile') { timings.downloaded = Math.round(performance.now() - started); setStatus('Compiling codex…') }
          else { timings.compiled = Math.round(performance.now() - started); setStatus('Starting codex…') }
        },
        onExit(exit) { if (current) setStatus(`codex ended (${exit.signal ? `signal ${exit.signal}` : `exit ${exit.code}`}).`) },
        onNotice(text) { if (current) setNotice(text) },
      })
      if (!current) return mounted.dispose()
      terminal.current = mounted
      handle.dispose = () => { handle.dispose = undefined; terminal.current = undefined; mounted.dispose() }
      window.__codex = Object.assign(mounted, { timings })
      // The TUI is up when it has drawn its input line; that is what a visitor waits for.
      const poll = setInterval(() => {
        if (!current) return clearInterval(poll)
        if (!mounted.screen().some(line => /^\s*›/.test(line) || /Sign in with ChatGPT/.test(line))) return
        clearInterval(poll)
        timings.prompt = Math.round(performance.now() - started)
        setStatus(chosen.backend !== 'openai' ? `Scripted model (${chosen.backend}); no sign-in, no tokens.`
          : chosen.net === 'tunnel' ? `Sign in inside the terminal. Requests go to OpenAI as TLS through the relay ${chosen.tcpRelay}, which only carries bytes.`
          : `Sign in inside the terminal. Requests go from this tab straight to OpenAI. ${module.codexOriginNote()}`)
        onPrompt?.(timings.prompt)
        void module.hasCodexCredentials().then(value => { if (current) setSignedIn(value) })
      }, 50)
    })().catch(error => { if (current) setStatus(`codex could not start: ${error instanceof Error ? error.message : String(error)}`) })
    return () => {
      current = false
      handle.dispose?.()
      target.replaceChildren()
    }
  // One codex per kernel; `run` restarts it. The settings are read from the page address once per start.
  }, [kernel, run])

  useEffect(() => { if (active) terminal.current?.focus() }, [active])

  // Forget the stored sign-in. A running codex holds it in memory, so it is stopped first and started again signed out.
  const clearCredentials = () => {
    handle.dispose?.()
    setStatus('Clearing stored credentials…')
    void load().then(module => module.clearCodexCredentials()).then(() => { setSignedIn(false); setRun(value => value + 1) })
  }

  return <div className="todo-editor-codex" hidden={!active}>
    <div className="todo-editor-codex-terminal" ref={container} />
    <footer>
      <p role="status" data-codex-status>{status}</p>
      {notice && <p role="alert" onClick={() => setNotice('')} title="Click to dismiss">{notice}</p>}
      <p>
        <button onClick={clearCredentials} title="Deletes the sign-in codex stored in this browser (auth.json). Nothing is revoked: use /logout in the terminal for that.">Clear stored credentials</button>{' '}
        <button onClick={() => setRun(value => value + 1)}>Restart codex</button>{' '}
        <small>{signedIn === undefined ? '' : signedIn ? 'A sign-in is stored in this browser.' : 'No sign-in is stored.'}</small>
      </p>
    </footer>
  </div>
}
