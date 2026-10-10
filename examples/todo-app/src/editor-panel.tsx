import { useEffect, useRef, useState } from 'react'
import { ChatView, EditorPreview, useEditor } from '@kkrausse/browser-agent-toolkit/react'
import { editorSteps, type BootRuntime, type EditorEvent } from '@kkrausse/browser-agent-toolkit/browser'
// Through this module, so the toolkit stays in the chunks only authorized users are served.
export { resetWorkspace, preloadEditor } from '@kkrausse/browser-agent-toolkit/browser'
import '@kkrausse/browser-agent-toolkit/styles.css'
import './editor-panel.css'
import CodexPanel, { type CodexHandle, type CodexKernel, type CodexPolicy } from './codex-panel'

const hostPaths = ['/api']
// The app is showing once its form is usable, not merely when the frame has loaded.
const isPreviewReady = (frame: HTMLIFrameElement) => !!frame.contentDocument?.querySelector('main input#title:not(:disabled)')

// Startup time is the point of this demo: keep each open's step times where a
// measuring script (and a person in the console) can read them.
declare global { interface Window { __editorTimings?: { current: Record<string, number>; runs: Record<string, number>[] } } }
const record = (event: EditorEvent) => {
  if (event.type !== 'step') return
  const store = (window.__editorTimings ??= { current: {}, runs: [] })
  if (event.step === 'manifest') store.runs.push(store.current = {})
  store.current[event.step] = event.ms
}
const seconds = (ms: number | undefined) => ms === undefined ? '…' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`

type Agent = 'opencode' | 'codex'
// Codex works on the runtime's own kernel (codex/worker.ts), which the toolkit's editor does not hand out:
// boot the runtime the manifest names ourselves, as `openEditor` would, and keep its kernel binding.
const bootKeepingKernel = (keep: (kernel: CodexKernel) => void): BootRuntime => async options => {
  const entry = (options.manifest as { runtime?: { entry?: string } }).runtime?.entry ?? 'runtime/host.js'
  const module = await import(/* @vite-ignore */ new URL(entry, options.manifestUrl).href)
  const host = await module.bootRuntime(options)
  keep(host.kernel)
  return host
}

export default function EditorPanel({ fakeHost, codex, onExit }: { fakeHost: boolean; codex?: CodexPolicy; onExit(): void }) {
  // Development only: the runtime's stand-in runs the programs natively behind the server.
  const [boot, setBoot] = useState<BootRuntime | undefined>()
  useEffect(() => {
    if (fakeHost) void import('@kkrausse/browser-agent-toolkit/fake').then(module => setBoot(() => module.bootFakeRuntime))
  }, [fakeHost])
  if (fakeHost && !boot) return null
  return <Opened boot={boot} codex={fakeHost ? undefined : codex} onExit={onExit} />
}

function Opened({ boot, codex, onExit }: { boot?: BootRuntime; codex?: CodexPolicy; onExit(): void }) {
  const kernel = useRef<CodexKernel>(undefined)
  const [keepKernel] = useState(() => bootKeepingKernel(value => { kernel.current = value }))
  const { editor, snapshot, retry } = useEditor({ boot: boot ?? (codex ? keepKernel : undefined), onEvent: record })
  // Which agent the panel shows. OpenCode's chat stays attached while Codex is shown, and the other way round.
  const [agent, setAgent] = useState<Agent>(() => codex && new URLSearchParams(location.search).get('agent') === 'codex' ? 'codex' : 'opencode')
  const [codexStarted, setCodexStarted] = useState(false)
  useEffect(() => { if (agent === 'codex') setCodexStarted(true) }, [agent])
  const [codexHandle] = useState<CodexHandle>(() => ({}))
  const [exiting, setExiting] = useState(false)
  const exit = () => {
    setExiting(true)
    // Codex first: its Worker is attached to the kernel the editor is about to take down.
    codexHandle.dispose?.()
    void (editor ? editor.close().catch(() => {}) : Promise.resolve()).then(onExit)
  }
  const { timings } = snapshot
  const shown = [...editorSteps, ...Object.keys(timings).filter(name => !(editorSteps as readonly string[]).includes(name))]
  return <div className={`todo-editor${agent === 'codex' ? ' todo-editor-wide' : ''}`}>
    <div className="todo-editor-preview">
      {editor && <EditorPreview editor={editor} hostPaths={hostPaths} isReady={isPreviewReady} />}
      {!timings['preview.visible'] && <p>{snapshot.status === 'failed' ? 'The preview is not running.' : 'Opening preview…'}</p>}
    </div>
    <aside className="todo-editor-panel" aria-label="Browser editor">
      <header>
        <strong>TODO browser editor</strong>
        {codex && <span role="tablist" aria-label="Agent">
          {(['opencode', 'codex'] as const).map(name => <button key={name} role="tab" aria-selected={agent === name} onClick={() => setAgent(name)}>{name === 'codex' ? 'Codex' : 'OpenCode'}</button>)}
        </span>}
        <button onClick={exit} disabled={exiting}>Exit</button>
      </header>
      <div className="todo-editor-chat" hidden={agent !== 'opencode'}>
        {editor ? <ChatView controller={editor.chat} showTitle={false} /> : <p>Starting…</p>}
      </div>
      {codex && codexStarted && (editor && kernel.current
        ? <CodexPanel kernel={kernel.current} policy={codex} active={agent === 'codex'} handle={codexHandle} onPrompt={() => editor.mark('codex.prompt')} />
        : agent === 'codex' && <p className="todo-editor-codex-wait">{snapshot.status === 'failed' ? 'Codex needs the editor, which did not open.' : 'Starting…'}</p>)}
      <footer>
        <p role="status">{snapshot.message}</p>
        {snapshot.error && <p role="alert">{snapshot.error} <button onClick={retry}>Retry</button></p>}
        <p className="todo-editor-timings" title="Milliseconds since Open editor, per startup step">
          {shown.map(step => <span key={step} data-step={step}>{step} <b>{seconds(timings[step])}</b></span>)}
        </p>
        <details><summary>Activity</summary><pre>{snapshot.log.join('\n')}</pre></details>
      </footer>
    </aside>
  </div>
}
