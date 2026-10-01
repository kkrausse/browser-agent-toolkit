import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { clearWorkspace, clearWorkspaceSource, type NodeLaunchOptions } from '@kev-browser-agent-kit/workspace'
import type { WorkspaceController } from '@kev-browser-agent-kit/workspace/react'
import { EditorPreview, useWorkspaceChat, attachChat, chatFor, detachChat } from '@kev-browser-agent-kit/opencode-chat/editor'
import { ChatView } from '@kev-browser-agent-kit/opencode-chat/react'
import type { ChatSnapshot } from '@kev-browser-agent-kit/opencode-chat'
import { loadPrepared } from '@kev-browser-agent-kit/opencode-chat/browser'
import { readyStatus, startBrowserEditor, startPreview } from './start-editor'
import { timedStage } from './editor-timings'
import { EditorTimings } from './editor-timings-panel'
import { captureSource, createWorkspaceStore, identityPath, idleChat, restoreSource, retainedRoots, safeSourcePath, upsert, validateWorkspace, writeIdentity, type Catalog, type SavedWorkspace } from './local-workspaces'
import { captureSessions, restoreSessions, retainedServerBlocker } from './workspace-sessions'
import { dependencyMismatch, switchWorkspace } from './workspace-switch'
import { interruptedSwitchError, workspaceSwitchPresentation } from './workspace-switch-presentation'
import { closeEditor, errorText, exitRecovery, footerError, snapshotErrorCode } from './workspace-exit'
import '@kev-browser-agent-kit/opencode-chat/editor.css'
import './workspace-editor.css'

const hostPaths = ['/api']
const isPreviewReady = (frame: HTMLIFrameElement) => !!frame.contentDocument?.querySelector('main input#title:not(:disabled)')
const emptyChat: ChatSnapshot = { connection: 'disconnected', execution: 'unknown', sending: false, loading: true, loadingOlder: false, interruptRequested: false, permissions: [], questions: [], unsupportedForms: [], sessions: [], models: [], messages: [], hasOlder: false }
const noopSubscribe = () => () => {}
const defaultName = 'Current workspace'
// A/B switch for measuring: ?workspaceSwitch=full never keeps OpenCode across a switch.
const fullSwitchForced = () => new URLSearchParams(location.search).get('workspaceSwitch') === 'full'

export function WorkspaceEditor({ controller, onExit }: { controller: WorkspaceController; onExit(warning?: string): void }): ReactNode {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [store] = useState(createWorkspaceStore)
  const catalog = useRef<Catalog>({ workspaces: [] })
  const [list, setList] = useState<SavedWorkspace[]>([])
  const [activeId, setActiveId] = useState('')
  const [name, setName] = useState(defaultName)
  const nameRef = useRef(name); nameRef.current = name
  const [pending, setPending] = useState<SavedWorkspace>()
  const [restoring, setRestoring] = useState(false)
  const locked = useRef(false)
  // The selection last written to the identity file, and the write in flight.
  const identitySelection = useRef<string | undefined>(undefined)
  const identityWrite = useRef(Promise.resolve())
  const [actionBusy, setActionBusy] = useState(false)
  // Set when an exit, or the stop inside a switch, failed with the workspace still attached.
  const [closeFailure, setCloseFailure] = useState<string>()
  // How the running preview was launched; a retained switch relaunches it as it was.
  const previewLaunch = useRef<NodeLaunchOptions | undefined>(undefined)
  const [note, setNote] = useState('Source and native chats are local to this browser. TODO items remain shared in host memory.')
  const switchPresentation = workspaceSwitchPresentation(pending, actionBusy)
  const { chat, error: chatError } = useWorkspaceChat(controller, restoring || switchPresentation?.phase === 'recovery' ? undefined : state.services.chat)
  const chatState = useSyncExternalStore(chat?.subscribe ?? noopSubscribe, chat?.getSnapshot ?? (() => emptyChat), chat?.getSnapshot ?? (() => emptyChat))
  const exitFailure = exitRecovery({ errorCode: snapshotErrorCode(state), failure: closeFailure, attached: !!state.workspace })
  // A failure a recovery alert already shows is not repeated in the footer alert.
  const footerAlert = footerError({ error: state.error, exitFailure: exitFailure ? closeFailure : undefined, switchRecovery: switchPresentation?.phase === 'recovery' })
  const blocked = actionBusy || state.busy || !!pending || !state.runtime || !idleChat(chat?.getSnapshot())

  async function persist(next: Catalog): Promise<void> {
    await store.write(next)
    catalog.current = next; setList(next.workspaces); setPending(next.pending); setActiveId(next.activeId ?? '')
  }
  // Chat idleness is acquired once and held, never re-sampled between awaits.
  // Throws unless chat is idle; the caller releases, and disposal also ends it.
  function holdChat(reason: string): { release(): void } {
    const service = controller.getSnapshot().services.chat
    const current = service && chatFor(service)
    if (!current) throw Error('Workspace chat must be ready before saving or switching')
    return current.hold(reason)
  }
  /** Caller holds chat admission. */
  async function capture(): Promise<SavedWorkspace> {
    const workspace = controller.workspace, service = controller.getSnapshot().services.chat
    if (!workspace || !service) throw Error('Workspace and chat must be ready before saving')
    await identityWrite.current
    await timedStage('workspace.flush', () => workspace.flush())
    const selectedSessionId = chatFor(service)?.getSnapshot().sessionID
    return validateWorkspace({ format: 1, id: catalog.current.activeId ?? crypto.randomUUID(), name: nameRef.current.trim() || 'Untitled workspace', savedAt: Date.now(), source: await captureSource(workspace), sessions: await captureSessions(service), selectedSessionId })
  }
  /** Caller holds chat admission. */
  async function saveCurrent(): Promise<SavedWorkspace> {
    const saved = await capture()
    await persist({ ...upsert(catalog.current, saved), activeId: saved.id })
    await writeIdentity(controller.workspace!, saved)
    identitySelection.current = saved.selectedSessionId
    return saved
  }
  /** Caller holds chat admission. Exit writes only what a reopen reads: the
   * identity file. Reopen boots from the durable working copy (source, and
   * OpenCode's own session database under /.server) and never restores a
   * catalog image, and a switch re-captures the outgoing workspace first, so the
   * active image may stay as of the last Save or switch. The full save is kept
   * where that image is still needed: never captured, or a working copy that is
   * not durable. A rename only changes a label: the select lists catalog names,
   * so that entry's name is rewritten and its image is left as it was. */
  async function saveForExit(): Promise<void> {
    const workspace = controller.workspace, service = controller.getSnapshot().services.chat
    const saved = catalog.current.workspaces.find(item => item.id === catalog.current.activeId)
    const title = nameRef.current.trim() || 'Untitled workspace'
    if (!workspace || !service || !saved || workspace.persistence.status !== 'durable') { await saveCurrent(); return }
    await identityWrite.current
    const selectedSessionId = chatFor(service)?.getSnapshot().sessionID
    await writeIdentity(workspace, { id: saved.id, name: title, selectedSessionId })
    identitySelection.current = selectedSessionId
    // Identity first: if the catalog write is lost, the next exit sees the names
    // differ and repeats it.
    if (saved.name !== title) await persist({ ...catalog.current, workspaces: catalog.current.workspaces.map(item => item.id === saved.id ? { ...item, name: title } : item) })
  }
  async function boot(incoming?: SavedWorkspace): Promise<void> {
    let mappedSelection: string | undefined
    previewLaunch.current = undefined
    const started = await startBrowserEditor(controller, {
      beforeSource: async () => {
        if (!incoming && catalog.current.pending) throw Error(interruptedSwitchError)
      },
      beforeChatConnect: incoming ? async service => {
        const ids = await restoreSessions(service, incoming.sessions)
        mappedSelection = incoming.selectedSessionId ? ids.get(incoming.selectedSessionId) : undefined
      } : undefined,
      // Allow hydration, but retain the UI checkpoint until the catalog commit.
      chatConnectReady: () => { setRestoring(false) },
    })
    previewLaunch.current = started.preview
    if (!incoming) {
      try { mappedSelection = JSON.parse(new TextDecoder().decode(await controller.workspace!.fs.readFile(identityPath))).selectedSessionId } catch { /* legacy identity */ }
    }
    await selectRestored(incoming, mappedSelection)
  }
  /** Chat is attached: select the session the workspace had selected and record it. */
  async function selectRestored(incoming: SavedWorkspace | undefined, mappedSelection: string | undefined): Promise<void> {
    const service = controller.getSnapshot().services.chat
    if (mappedSelection && service) await timedStage('chat.select-session', async () => { await chatFor(service)?.selectSession(mappedSelection!) })
    if (incoming) await writeIdentity(controller.workspace!, { ...incoming, selectedSessionId: mappedSelection })
    identitySelection.current = mappedSelection
    // Services run again, so an earlier unproven stop no longer needs a way out.
    setCloseFailure(undefined)
  }
  // First mount and Retry editing share this: a first open that failed (for
  // example while another tab owned the store) must still load the catalog,
  // adopt an unadopted working copy and show the active workspace's name.
  async function open(): Promise<void> {
    catalog.current = await store.read()
    setList(catalog.current.workspaces); setPending(catalog.current.pending); setActiveId(catalog.current.activeId ?? '')
    // Startup can fail before the identity file is readable (another tab owns the
    // store, an interrupted switch). The catalog already names the active
    // workspace, as the select shows; only fill the placeholder.
    const listed = catalog.current.workspaces.find(item => item.id === catalog.current.activeId)?.name
    if (listed && nameRef.current === defaultName) setName(listed)
    await boot()
    // First activation adopts the existing durable working copy. It never
    // restores a catalog image over unsaved browser source/native sessions.
    if (!catalog.current.activeId) {
      const hold = holdChat('Saving workspace')
      try { await saveCurrent() } finally { hold.release() }
    } else if (nameRef.current === defaultName || nameRef.current === listed) {
      // The identity file is the working copy's own name. Only replace what an
      // open filled in; a retry must not discard a name being edited.
      let title = listed ?? defaultName
      try { title = JSON.parse(new TextDecoder().decode(await controller.workspace!.fs.readFile(identityPath))).name ?? title } catch { /* legacy identity */ }
      setName(title)
    }
  }
  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      void controller.run('Open TODO workspace', open)
    })
    const close = () => { void controller.cancelAndClose().catch(error => controller.reportError(error)) }
    window.addEventListener('pagehide', close)
    return () => { cancelled = true; window.removeEventListener('pagehide', close) }
  }, [controller, store])

  // Exit, Save and a switch write the identity file; a reload or a closed tab runs
  // none of them, so a session selected since was lost. Write that one small file
  // once the selected chat is idle: no capture and no catalog write. Never during a
  // workspace action or a chat hold, which write it themselves and first wait for a
  // write started here (capture and saveForExit), so the two cannot interleave.
  useEffect(() => {
    const selected = chatState.sessionID, workspace = controller.workspace
    const saved = catalog.current.workspaces.find(item => item.id === catalog.current.activeId)
    if (!chat || !selected || selected === identitySelection.current || !workspace || !saved) return
    if (locked.current || actionBusy || state.busy || pending || restoring || !idleChat(chatState)) return
    identitySelection.current = selected
    identityWrite.current = identityWrite.current
      .then(() => writeIdentity(workspace, { id: saved.id, name: saved.name, selectedSessionId: selected }))
      .catch(() => { if (identitySelection.current === selected) identitySelection.current = undefined })
  }, [chat, chatState, controller, actionBusy, state.busy, pending, restoring])

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
        const hold = holdChat('Writing source fixture')
        locked.current = true; setActionBusy(true)
        try { await controller.workspace.fs.writeFile(path, text); await controller.workspace.flush() }
        finally { hold.release(); locked.current = false; setActionBusy(false) }
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
    const hold = holdChat('Saving workspace')
    try {
      const saved = await saveCurrent()
      setNote(`Saved ${saved.name} locally, including resumable native sessions.`)
    } finally { hold.release() }
  }
  // Exit saves and closes under one hold, so nothing can start after the save.
  // Only an attached chat is held and saved (see saveForExit). With none (startup
  // failed, or an earlier unproven stop already detached the services) there is
  // nothing to protect or save, and the working copy is durable on its own. Force
  // skips the save: it is the way out when saving or stopping cannot complete.
  async function exit(force = false): Promise<void> {
    const service = controller.getSnapshot().services.chat
    let hold: { release(): void } | undefined, warning: string | undefined
    try {
      if (!force && !pending && service && chatFor(service)) hold = holdChat('Closing editor')
      if (hold) await saveForExit()
      warning = (await closeEditor({ force, close: options => controller.close(options), attached: () => !!controller.workspace })).warning
    } catch (error) {
      setCloseFailure(errorText(error))
      throw error
    } finally { hold?.release() }
    setCloseFailure(undefined)
    onExit(warning)
  }
  async function replace(incoming: SavedWorkspace, retry = false, held?: { release(): void }): Promise<void> {
    await switchWorkspace({ incoming, catalog: catalog.current, retry,
      hold: () => held ?? holdChat('Switching workspace'), capture, persist,
      disposeChat: async () => {
        setRestoring(true)
        // Also forgets the client, so a server that keeps running gets a fresh one.
        const service = controller.getSnapshot().services.chat
        if (service) await detachChat(service)
      },
      stop: () => controller.stopRuntime().catch(error => { setCloseFailure(errorText(error)); throw error }),
      replace: async saved => { await clearWorkspace(controller.workspace!); await restoreSource(controller.workspace!, saved) },
      start: saved => boot(saved),
      retained: {
        blocker: retainedBlocker,
        stopPreview: () => controller.stopService('vite'),
        replaceSource: async saved => { await clearWorkspaceSource(controller.workspace!, { keep: retainedRoots }); await restoreSource(controller.workspace!, saved) },
        resume,
      },
      onPath: taken => controller.diagnostic('switch.path', taken),
    })
    setName(incoming.name)
    setNote(`Opened ${incoming.name}. Outgoing source and native sessions were saved before replacement.`)
  }
  /** Asked with chat admission held, before the switch disposes or removes anything. */
  async function retainedBlocker(outgoing: SavedWorkspace, incoming: SavedWorkspace): Promise<string | undefined> {
    if (fullSwitchForced()) return 'forced by ?workspaceSwitch=full'
    const { chat: service, vite } = controller.getSnapshot().services
    if (!controller.runtime || !service || !vite || !previewLaunch.current) return 'preview or OpenCode is not running'
    if (!chatFor(service)?.getSnapshot().held) return 'chat admission is not held'
    // The retained /workspace/node_modules is the outgoing workspace's install.
    return dependencyMismatch(outgoing.source, incoming.source) ?? await retainedServerBlocker(service)
  }
  /** A retained switch's start. Runtime, dependencies, OpenCode's configuration and
   * its process are as they were, so only the preview is launched; sessions are
   * replaced as on the full path and a fresh chat client mounts on the same service. */
  async function resume(incoming: SavedWorkspace): Promise<void> {
    const service = controller.getSnapshot().services.chat, preview = previewLaunch.current
    if (!service || !preview) throw Error('OpenCode stopped during the workspace switch')
    controller.status('Restarting preview; OpenCode keeps running…')
    await timedStage('switch.start-preview', () => startPreview(controller, preview))
    const ids = await restoreSessions(service, incoming.sessions)
    // Allow hydration, but retain the UI checkpoint until the catalog commit.
    setRestoring(false)
    // The service's client promise resolved on its first attach; wait for this one.
    await attachChat(controller, service)
    await selectRestored(incoming, incoming.selectedSessionId ? ids.get(incoming.selectedSessionId) : undefined)
    controller.status(readyStatus)
  }
  async function create(): Promise<void> {
    const hold = holdChat('Creating workspace')
    try {
      const title = window.prompt('New workspace name', 'New workspace')?.trim()
      if (!title) return
      const manifest = await loadPrepared('/editor/prepared/', controller.signal)
      const source = Object.fromEntries(Object.entries(manifest.project).map(([path, file]) => [path, typeof file === 'string' ? new TextEncoder().encode(file) : Uint8Array.from(atob(file.data), character => character.charCodeAt(0))]))
      await replace(validateWorkspace({ format: 1, id: crypto.randomUUID(), name: title, savedAt: Date.now(), source, sessions: [] }), false, hold)
    } finally { hold.release() }
  }
  const controls = <div className="todo-workspace-controls">
    <label>Workspace<select aria-label="Workspace" disabled={blocked} value={activeId} onChange={event => {
      const incoming = list.find(item => item.id === event.target.value)
      if (incoming) action('Switch workspace', () => replace(incoming))
    }}>{!activeId && <option value="">Current workspace</option>}{list.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label>Name<input aria-label="Workspace name" value={name} maxLength={120} disabled={actionBusy || state.busy || !!pending} onChange={event => setName(event.target.value)} /></label>
    <div className="todo-workspace-buttons"><button disabled={blocked} onClick={() => action('New workspace', create)}>New workspace</button><button disabled={blocked} onClick={() => action('Save workspace', save)}>Save workspace</button><button disabled={actionBusy || state.busy || (!pending && !!chat && !idleChat(chat.getSnapshot()))} onClick={() => action('Close editor', () => exit())}>Exit</button></div>
  </div>
  return <div className="todo-workspace-editor">
    <div className="todo-workspace-preview"><EditorPreview controller={controller} service={state.services.vite} name="vite" hostPaths={hostPaths} isReady={isPreviewReady} />{!state.services.vite && <p>Opening workspace preview…</p>}</div>
    <aside className="todo-workspace-panel" aria-label="Browser workspace controls">
      <header><strong>TODO browser editor</strong>{controls}<p role="status">{note}</p></header>
      {pending && switchPresentation && <div role={switchPresentation.role} className={switchPresentation.phase === 'recovery' ? 'todo-workspace-recovery' : undefined}><p>{switchPresentation.message}</p>{switchPresentation.phase === 'recovery' && <><button disabled={state.busy || actionBusy} onClick={() => action('Retry interrupted switch', () => replace(pending, true))}>Retry interrupted switch</button>{catalog.current.workspaces.find(item => item.id === catalog.current.activeId) && <button disabled={state.busy || actionBusy} onClick={() => action('Recover outgoing workspace', () => replace(catalog.current.workspaces.find(item => item.id === catalog.current.activeId)!, true))}>Recover outgoing workspace</button>}</>}</div>}
      {exitFailure && <div role={exitFailure.role} className="todo-workspace-recovery"><p>{exitFailure.message}</p><button disabled={state.busy || actionBusy} onClick={() => action('Close editor', () => exit())}>Retry exit</button><button disabled={state.busy || actionBusy} onClick={() => {
        if (window.confirm('Force exit closes the editor without confirming that preview and OpenCode stopped, and without saving again. Files already saved in this browser are kept. Force exit?')) action('Force close editor', () => exit(true))
      }}>Force exit without confirmed cleanup</button></div>}
      <div className="todo-workspace-chat" inert={actionBusy || state.busy || !!pending || restoring}>
        {chat && !pending && !restoring ? <ChatView controller={chat} showModels showSessions /> : <p>{switchPresentation?.phase === 'switching' ? 'Connecting workspace chat…' : switchPresentation?.phase === 'recovery' ? 'Recover the interrupted switch to reconnect chat.' : chatError || 'Starting OpenCode…'}</p>}
      </div>
      <footer><p role="status">{switchPresentation ? switchPresentation.phase === 'switching' ? 'Workspace switch in progress…' : 'Workspace recovery required.' : state.status}</p>{footerAlert && <p role="alert">{footerAlert}</p>}{state.error && !pending && <button disabled={state.busy || actionBusy} onClick={() => action('Retry editor startup', open)}>Retry editing</button>}<small>{blocked && !state.busy && !pending ? chat ? `Workspace actions wait for connected, idle chat (${chatState.execution}).` : 'Preview and OpenCode are not running. Retry editing to continue working, or exit.' : 'Switching restarts the preview; OpenCode restarts too unless it can be kept.'}</small><details><summary>Debug · Activity</summary><pre>{state.logs.join('\n')}</pre></details></footer>
    </aside>
    <EditorTimings controller={controller} />
  </div>
}
