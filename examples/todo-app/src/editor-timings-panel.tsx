import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { diagnoseWorkspace } from '@kev-browser-agent-kit/workspace'
import type { WorkspaceController } from '@kev-browser-agent-kit/workspace/react'
import { chatFor } from '@kev-browser-agent-kit/opencode-chat/editor'
import { editorTimings, type TimingFacts, type TimingOperation } from './editor-timings'
import './editor-timings.css'

const seconds = (ms: number | undefined) => ms === undefined ? '…' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`
const number = (value: unknown) => typeof value === 'number' && value >= 0 ? value : undefined

/** Counts from the kernel's own diagnostics reply. Waits at most 3 s and is never awaited by an operation. */
async function guestCounts(controller: WorkspaceController): Promise<TimingFacts | undefined> {
  const workspace = controller.workspace
  if (!workspace) return undefined
  const diag = await Promise.race([diagnoseWorkspace(workspace), new Promise<undefined>(resolve => setTimeout(resolve, 3000))])
  if (!diag) return undefined
  // The runtime reports more than the typed contract: VFS size and worker counts.
  const extra = diag as typeof diag & { vfs?: { files?: unknown; bytes?: unknown; logical?: unknown } | null; workers?: { process?: unknown } }
  const heaps = diag.procs.map(process => number((process as { heapBytes?: unknown }).heapBytes) ?? 0)
  return {
    processes: diag.procs.length, processWorkers: number(extra.workers?.process), listeners: diag.listeners.length, pendingHttp: diag.pendingHttp,
    fetchInflight: diag.fetch?.inflight, fetchCachedEntries: diag.fetch?.cachedEntries, fetchCachedBytes: diag.fetch?.cachedBytes,
    vfsFiles: number(extra.vfs?.files), vfsBytes: number(extra.vfs?.bytes), vfsLogicalBytes: number(extra.vfs?.logical),
    processHeapBytes: heaps.reduce((sum, bytes) => sum + bytes, 0) || undefined,
  }
}

/** Stages of one operation in start order, repeats of a name folded into one row. */
function rows(operation: TimingOperation): { name: string; depth: number; ms: number; selfMs?: number; count: number; failed: boolean }[] {
  const out = new Map<string, { name: string; depth: number; ms: number; selfMs?: number; count: number; failed: boolean }>()
  for (const stage of operation.stages) {
    const row = out.get(stage.name) ?? { name: stage.name, depth: stage.depth, ms: 0, count: 0, failed: false }
    row.ms += stage.durationMs ?? 0; row.count++; row.failed ||= stage.status === 'failed'
    if (stage.selfMs !== undefined) row.selfMs = (row.selfMs ?? 0) + stage.selfMs
    out.set(stage.name, row)
  }
  return [...out.values()]
}
function contextLine(operation: TimingOperation): string {
  const { context } = operation, start = context.start, guest = (context.end?.guest ?? start.guest) as TimingFacts | undefined
  return [
    `kernel ${context.kernel}`,
    context.storedState === undefined ? '' : context.storedState ? 'stored working copy' : 'empty store',
    start.swControlled === undefined ? '' : start.swControlled ? 'service worker controlling' : 'no service worker yet',
    context.kernelCreatedSwControlled === undefined ? '' : `kernel created ${context.kernelCreatedSwControlled ? 'under' : 'without'} service worker`,
    context.openCodeHealthAttempts === undefined ? '' : `OpenCode health probes ${context.openCodeHealthAttempts}`,
    `chat sessions ${String(context.end?.chatSessions ?? start.chatSessions ?? context.workspace?.chatSessions ?? '?')}`,
    guest ? `guest processes ${String(guest.processes)}, VFS files ${String(guest.vfsFiles ?? '?')}` : '',
    context.hiddenMs ? `tab hidden ${seconds(context.hiddenMs)}` : '',
    context.maxTimerLagMs > 250 ? `timer lag ${seconds(context.maxTimerLagMs)}` : '',
  ].filter(Boolean).join(' · ')
}

/** Collapsed stage timings of recent operations; the same records as `window.__editorTimings`. */
export function EditorTimings({ controller }: { controller: WorkspaceController }): ReactNode {
  useSyncExternalStore(editorTimings.subscribe, editorTimings.getVersion, editorTimings.getVersion)
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => editorTimings.setProbe({
    sample() {
      const snapshot = controller.getSnapshot(), chat = snapshot.services.chat && chatFor(snapshot.services.chat)?.getSnapshot()
      return { workspaceOpen: !!snapshot.workspace, runtimeRunning: !!snapshot.runtime, persistence: snapshot.persistence, services: Object.keys(snapshot.services).length, chatSessions: chat?.sessions.length, chatMessages: chat?.messages.length }
    },
    guest: () => guestCounts(controller),
  }), [controller])
  const recent = editorTimings.operations.slice(-8).reverse(), latest = recent[0]
  async function copy(): Promise<void> {
    try { await navigator.clipboard.writeText(editorTimings.json()); setNotice('Copied.') }
    catch { setNotice('Copy was blocked; use Download JSON.') }
  }
  function download(): void {
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([editorTimings.json()], { type: 'application/json' }))
    link.download = `editor-timings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 1000)
    setNotice('Downloaded.')
  }
  return <details className="todo-timings" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Debug · Timings{latest ? ` · ${latest.kind} ${seconds(latest.durationMs)}${latest.status === 'failed' ? ' (failed)' : ''}` : ''}</summary>
    {open && <>
      <div className="todo-timings-actions"><button onClick={() => void copy()}>Copy JSON</button><button onClick={download}>Download JSON</button><button onClick={() => { editorTimings.clear(); setNotice('') }}>Clear</button><small role="status">{notice}</small></div>
      {!recent.length && <p>No operations recorded yet.</p>}
      {recent.map(operation => <details key={operation.seq}>
        <summary>{new Date(operation.startedAt).toLocaleTimeString()} · {operation.kind} · {seconds(operation.durationMs)}{operation.status === 'failed' ? ` · failed${operation.failedStage ? ` in ${operation.failedStage}` : ''}` : ''}</summary>
        <small>{contextLine(operation)}</small>
        <table><tbody>
          {rows(operation).filter(row => row.ms >= 5 || row.failed).map(row => <tr key={row.name} className={row.failed ? 'todo-timings-failed' : undefined}>
            <td style={{ paddingLeft: row.depth * 10 }}>{row.name}{row.count > 1 ? ` ×${row.count}` : ''}</td>
            <td>{seconds(row.ms)}</td>
            <td>{row.selfMs !== undefined && row.selfMs >= 5 ? `self ${seconds(row.selfMs)}` : ''}</td>
          </tr>)}
          {(operation.unaccountedMs ?? 0) >= 5 && <tr><td>(outside any stage)</td><td>{seconds(operation.unaccountedMs)}</td><td /></tr>}
        </tbody></table>
      </details>)}
    </>}
  </details>
}
