import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { clearWorkspace } from '@kev-browser-agent-kit/workspace'
import type { WorkspaceController } from '@kev-browser-agent-kit/workspace/react'
import { EditorPreview, useWorkspaceChat, chatFor } from '@kev-browser-agent-kit/opencode-chat/editor'
import { ChatView } from '@kev-browser-agent-kit/opencode-chat/react'
import type { ChatSnapshot } from '@kev-browser-agent-kit/opencode-chat'
import { loadPrepared } from '@kev-browser-agent-kit/opencode-chat/browser'
import { startBrowserEditor } from './start-editor'
import { captureSource, createWorkspaceStore, identityPath, idleChat, restoreSource, safeSourcePath, upsert, validateWorkspace, writeIdentity, type Catalog, type SavedWorkspace } from './local-workspaces'
import { captureSessions, restoreSessions } from './workspace-sessions'
import { switchWorkspace } from './workspace-switch'
import { workspaceSwitchPresentation } from './workspace-switch-presentation'
import '@kev-browser-agent-kit/opencode-chat/editor.css'
import './workspace-editor.css'

const hostPaths = ['/api']
const isPreviewReady = (frame: HTMLIFrameElement) => !!frame.contentDocument?.querySelector('main input#title:not(:disabled)')
const emptyChat: ChatSnapshot = { connection: 'disconnected', execution: 'unknown', sending: false, loading: true, loadingOlder: false, interruptRequested: false, permissions: [], questions: [], unsupportedForms: [], sessions: [], models: [], messages: [], hasOlder: false }
const noopSubscribe = () => () => {}

export function WorkspaceEditor({ controller, onExit }: { controller: WorkspaceController; onExit(): void }): ReactNode {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [store] = useState(createWorkspaceStore)
  const catalog = useRef<Catalog>({ workspaces: [] })
  const [list, setList] = useState<SavedWorkspace[]>([])
  const [activeId, setActiveId] = useState('')
  const [name, setName] = useState('Current workspace')
  const nameRef = useRef(name); nameRef.current = name
  const [pending, setPending] = useState<SavedWorkspace>()
  const [restoring, setRestoring] = useState(false)
  const locked = useRef(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [note, setNote] = useState('Source and native chats are local to this browser. TODO items remain shared in host memory.')
  const switchPresentation = workspaceSwitchPresentation(pending, actionBusy)
  const { chat, error: chatError } = useWorkspaceChat(controller, restoring || switchPresentation?.phase === 'recovery' ? undefined : state.services.chat)
  const chatState = useSyncExternalStore(chat?.subscribe ?? noopSubscribe, chat?.getSnapshot ?? (() => emptyChat), chat?.getSnapshot ?? (() => emptyChat))
  const blocked = actionBusy || state.busy || !!pending || !state.runtime || !idleChat(chat?.getSnapshot())

  async function persist(next: Catalog): Promise<void> {
    await store.write(next)
    catalog.current = next; setList(next.workspaces); setPending(next.pending); setActiveId(next.activeId ?? '')
  }
  function assertIdle(retry = false): void {
    if (retry) return
    const service = controller.getSnapshot().services.chat
    const current = service && chatFor(service)
    if (!idleChat(current?.getSnapshot())) throw Error('Wait for chat execution, loading and requests to finish before saving or switching')
  }
  async function capture(): Promise<SavedWorkspace> {
    const workspace = controller.workspace, service = controller.getSnapshot().services.chat
    if (!workspace || !service) throw Error('Workspace and chat must be ready before saving')
    const currentChat = chatFor(service)
    if (!idleChat(currentChat?.getSnapshot())) throw Error('Chat is not idle')
    await workspace.flush()
    const selectedSessionId = currentChat?.getSnapshot().sessionID
    const saved = validateWorkspace({ format: 1, id: catalog.current.activeId ?? crypto.randomUUID(), name: nameRef.current.trim() || 'Untitled workspace', savedAt: Date.now(), source: await captureSource(workspace), sessions: await captureSessions(service), selectedSessionId })
    if (!idleChat(currentChat?.getSnapshot())) throw Error('Chat became busy; workspace was not replaced')
    return saved
  }
  async function boot(incoming?: SavedWorkspace): Promise<void> {
    let mappedSelection: string | undefined
    await startBrowserEditor(controller, {
      beforeSource: async () => {
        if (!incoming && catalog.current.pending) throw Error('Interrupted workspace replacement retained. Choose Retry interrupted switch or Recover outgoing workspace.')
      },
      beforeChatConnect: incoming ? async service => {
        const ids = await restoreSessions(service, incoming.sessions)
        mappedSelection = incoming.selectedSessionId ? ids.get(incoming.selectedSessionId) : undefined
      } : undefined,
      // Allow hydration, but retain the UI checkpoint until the catalog commit.
      chatConnectReady: () => { setRestoring(false) },
    })
    const service = controller.getSnapshot().services.chat
    if (!incoming) {
      try { mappedSelection = JSON.parse(new TextDecoder().decode(await controller.workspace!.fs.readFile(identityPath))).selectedSessionId } catch { /* legacy identity */ }
    }
    if (mappedSelection && service) await chatFor(service)?.selectSession(mappedSelection)
    if (incoming) await writeIdentity(controller.workspace!, { ...incoming, selectedSessionId: mappedSelection })
  }
  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      void controller.run('Open TODO workspace', async () => {
        catalog.current = await store.read()
        setList(catalog.current.workspaces); setPending(catalog.current.pending); setActiveId(catalog.current.activeId ?? '')
        await boot()
        // First activation adopts the existing durable working copy. It never
        // restores a catalog image over unsaved browser source/native sessions.
        if (!catalog.current.activeId) {
          const saved = await capture()
          await persist({ ...upsert(catalog.current, saved), activeId: saved.id })
          await writeIdentity(controller.workspace!, saved)
        } else {
          const saved = catalog.current.workspaces.find(item => item.id === catalog.current.activeId)
          let title = saved?.name ?? 'Current workspace'
          try { title = JSON.parse(new TextDecoder().decode(await controller.workspace!.fs.readFile(identityPath))).name ?? title } catch { /* legacy identity */ }
          setName(title)
        }
      })
    })
    const close = () => { void controller.cancelAndClose().catch(error => controller.reportError(error)) }
    window.addEventListener('pagehide', close)
    return () => { cancelled = true; window.removeEventListener('pagehide', close) }
  }, [controller, store])

  useEffect(() => {
    if (new URLSearchParams(location.search).get('workspaceFixture') !== '1') return
    const target = window as Window & { __todoWorkspaceFixture?: { readSource(path: string): Promise<string>; writeSource(path: string, text: string): Promise<void> } }
    // Explicitly opt-in test fixture, not a source-editor UI or a way to bypass
    // switch admission. Parent may use it for identifiable A/B source edits.
    target.__todoWorkspaceFixture = {
      async readSource(path) {
        if (!safeSourcePath(path) || !controller.workspace) throw Error('Invalid source path or closed workspace')
        return new TextDecoder().decode(await controller.workspace.fs.readFile(path))
      },
      async writeSource(path, text) {
        if (!safeSourcePath(path) || !controller.workspace || text.length > 1_000_000) throw Error('Invalid source fixture write')
        if (locked.current || controller.getSnapshot().busy || catalog.current.pending) throw Error('Workspace action in progress')
        assertIdle()
        locked.current = true; setActionBusy(true)
        try { await controller.workspace.fs.writeFile(path, text); await controller.workspace.flush() }
        finally { locked.current = false; setActionBusy(false) }
      },
    }
    return () => { delete target.__todoWorkspaceFixture }
  }, [controller])

  function action(label: string, task: () => Promise<void>): void {
    if (locked.current || controller.getSnapshot().busy) return
    locked.current = true; setActionBusy(true)
    void controller.run(label, task).finally(() => { setPending(catalog.current.pending); locked.current = false; setActionBusy(false) })
  }
  async function save(): Promise<void> {
    assertIdle()
    const saved = await capture()
    await persist({ ...upsert(catalog.current, saved), activeId: saved.id })
    await writeIdentity(controller.workspace!, saved)
    setNote(`Saved ${saved.name} locally, including resumable native sessions.`)
  }
  async function replace(incoming: SavedWorkspace, retry = false): Promise<void> {
    await switchWorkspace({ incoming, catalog: catalog.current, retry,
      assertIdle: () => assertIdle(retry), capture, persist,
      disposeChat: async () => {
        setRestoring(true)
        const service = controller.getSnapshot().services.chat
        if (service) await chatFor(service)?.dispose()
      },
      stop: () => controller.stopRuntime(),
      replace: async saved => { await clearWorkspace(controller.workspace!); await restoreSource(controller.workspace!, saved) },
      start: saved => boot(saved),
    })
    setName(incoming.name)
    setNote(`Opened ${incoming.name}. Outgoing source and native sessions were saved before replacement.`)
  }
  async function create(): Promise<void> {
    assertIdle()
    const title = window.prompt('New workspace name', 'New workspace')?.trim()
    if (!title) return
    const manifest = await loadPrepared('/editor/prepared/', controller.signal)
    const source = Object.fromEntries(Object.entries(manifest.project).map(([path, file]) => [path, typeof file === 'string' ? new TextEncoder().encode(file) : Uint8Array.from(atob(file.data), character => character.charCodeAt(0))]))
    await replace(validateWorkspace({ format: 1, id: crypto.randomUUID(), name: title, savedAt: Date.now(), source, sessions: [] }))
  }
  const controls = <div className="todo-workspace-controls">
    <label>Workspace<select aria-label="Workspace" disabled={blocked} value={activeId} onChange={event => {
      const incoming = list.find(item => item.id === event.target.value)
      if (incoming) action('Switch workspace', () => replace(incoming))
    }}>{!activeId && <option value="">Current workspace</option>}{list.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label>Name<input aria-label="Workspace name" value={name} maxLength={120} disabled={actionBusy || state.busy || !!pending} onChange={event => setName(event.target.value)} /></label>
    <div className="todo-workspace-buttons"><button disabled={blocked} onClick={() => action('New workspace', create)}>New workspace</button><button disabled={blocked} onClick={() => action('Save workspace', save)}>Save workspace</button><button disabled={actionBusy || state.busy || (!pending && !!state.runtime && !idleChat(chat?.getSnapshot()))} onClick={() => action('Close editor', async () => { if (!pending && controller.runtime) await save(); await controller.close(); onExit() })}>Exit</button></div>
  </div>
  return <div className="todo-workspace-editor">
    <div className="todo-workspace-preview"><EditorPreview controller={controller} service={state.services.vite} name="vite" hostPaths={hostPaths} isReady={isPreviewReady} />{!state.services.vite && <p>Opening workspace preview…</p>}</div>
    <aside className="todo-workspace-panel" aria-label="Browser workspace controls">
      <header><strong>TODO browser editor</strong>{controls}<p role="status">{note}</p></header>
      {pending && switchPresentation && <div role={switchPresentation.role} className={switchPresentation.phase === 'recovery' ? 'todo-workspace-recovery' : undefined}><p>{switchPresentation.message}</p>{switchPresentation.phase === 'recovery' && <><button disabled={state.busy || actionBusy} onClick={() => action('Retry interrupted switch', () => replace(pending, true))}>Retry interrupted switch</button>{catalog.current.workspaces.find(item => item.id === catalog.current.activeId) && <button disabled={state.busy || actionBusy} onClick={() => action('Recover outgoing workspace', () => replace(catalog.current.workspaces.find(item => item.id === catalog.current.activeId)!, true))}>Recover outgoing workspace</button>}</>}</div>}
      <div className="todo-workspace-chat" inert={actionBusy || state.busy || !!pending || restoring}>
        {chat && !pending && !restoring ? <ChatView controller={chat} showModels showSessions /> : <p>{switchPresentation?.phase === 'switching' ? 'Connecting workspace chat…' : switchPresentation?.phase === 'recovery' ? 'Recover the interrupted switch to reconnect chat.' : chatError || 'Starting OpenCode…'}</p>}
      </div>
      <footer><p role="status">{switchPresentation ? switchPresentation.phase === 'switching' ? 'Workspace switch in progress…' : 'Workspace recovery required.' : state.status}</p>{state.error && <p role="alert">{state.error}</p>}{state.error && !pending && <button disabled={state.busy || actionBusy} onClick={() => action('Retry editor startup', () => boot())}>Retry editing</button>}<small>{blocked && !state.busy && !pending ? `Workspace actions wait for connected, idle chat (${chatState.execution}).` : 'Switching fully stops and restarts preview and OpenCode.'}</small><details><summary>Debug · Activity</summary><pre>{state.logs.join('\n')}</pre></details></footer>
    </aside>
  </div>
}
