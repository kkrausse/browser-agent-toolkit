import { useEffect, useState } from 'react'
import { ChatView, EditorPreview, useEditor } from '@kkrausse/browser-agent-toolkit/react'
import { editorSteps, type BootRuntime, type EditorEvent } from '@kkrausse/browser-agent-toolkit/browser'
import '@kkrausse/browser-agent-toolkit/styles.css'
import './editor-panel.css'

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

export default function EditorPanel({ fakeHost, onExit }: { fakeHost: boolean; onExit(): void }) {
  // Development only: the runtime's stand-in runs the programs natively behind the server.
  const [boot, setBoot] = useState<BootRuntime | undefined>()
  useEffect(() => {
    if (fakeHost) void import('@kkrausse/browser-agent-toolkit/fake').then(module => setBoot(() => module.bootFakeRuntime))
  }, [fakeHost])
  if (fakeHost && !boot) return null
  return <Opened boot={boot} onExit={onExit} />
}

function Opened({ boot, onExit }: { boot?: BootRuntime; onExit(): void }) {
  const { editor, snapshot, retry } = useEditor({ boot, onEvent: record })
  const [exiting, setExiting] = useState(false)
  const exit = () => {
    setExiting(true)
    void (editor ? editor.close().catch(() => {}) : Promise.resolve()).then(onExit)
  }
  const { timings } = snapshot
  const shown = [...editorSteps, ...Object.keys(timings).filter(name => !(editorSteps as readonly string[]).includes(name))]
  return <div className="todo-editor">
    <div className="todo-editor-preview">
      {editor && <EditorPreview editor={editor} hostPaths={hostPaths} isReady={isPreviewReady} />}
      {!timings['preview.visible'] && <p>{snapshot.status === 'failed' ? 'The preview is not running.' : 'Opening preview…'}</p>}
    </div>
    <aside className="todo-editor-panel" aria-label="Browser editor">
      <header>
        <strong>TODO browser editor</strong>
        <button onClick={exit} disabled={exiting}>Exit</button>
      </header>
      <div className="todo-editor-chat">
        {editor ? <ChatView controller={editor.chat} showTitle={false} /> : <p>Starting…</p>}
      </div>
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
