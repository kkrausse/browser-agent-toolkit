import type { ControllerDiagnosticEvent } from '@kev-browser-agent-kit/workspace/react'

/** Stage timings of the editor's slow operations (open, reopen, switch, save, exit),
 * kept in memory and exposed as `window.__editorTimings` and in the Timings disclosure.
 * Fed by the workspace controller's diagnostics sink plus this app's own `timedStage`
 * calls. Durations, counts and sizes only: no prompts, file contents, keys or URLs. */

export type OperationKind = 'open' | 'boot' | 'reopen' | 'switch' | 'new-workspace' | 'save' | 'exit' | 'force-exit' | 'retry-switch' | 'recover-switch' | 'other'
export interface TimingEvent {
  /** Milliseconds since the operation started (since page load when unattached). */
  t: number
  event: string
  data?: Record<string, unknown>
}
export interface TimingStage {
  name: string
  /** Milliseconds since the operation started. */
  startMs: number
  durationMs?: number
  /** Duration not covered by nested stages; present only when the stage has any. */
  selfMs?: number
  status: 'ok' | 'failed' | 'open'
  /** Enclosing stage, if any. Stages of one kind that overlap (two service stops) are siblings. */
  parent?: string
  depth: number
  detail?: Record<string, unknown>
}
export type TimingFacts = Record<string, unknown>
export interface TimingContext {
  /** 1 for the first operation of this kind since page load. */
  nthOfKind: number
  /** cold: the kernel worker booted during this operation; warm: it was already open. */
  kernel: 'cold' | 'warm' | 'none'
  /** A working copy already existed in this browser when the editor opened. */
  storedState?: boolean
  /** Whether a service worker controlled the page when the current kernel worker was created. */
  kernelCreatedSwControlled?: boolean
  /** OpenCode `/api/health` probes until the first success (each failure waits up to 3 s). */
  openCodeHealthAttempts?: number
  kernelBootsInPage: number
  runtimeStartsInKernel: number
  /** Time the tab was hidden during the operation (background tabs throttle timers). */
  hiddenMs: number
  /** Worst main-thread timer delay seen during the operation, sampled every 500 ms. */
  maxTimerLagMs: number
  start: TimingFacts
  end?: TimingFacts
  manifest?: TimingFacts
  /** Size of what a save or switch captured, restored or wrote. */
  workspace?: TimingFacts
}
export interface TimingOperation {
  seq: number
  kind: OperationKind
  label: string
  runId?: string
  startedAt: string
  sinceLoadMs: number
  endedAt?: string
  durationMs?: number
  status: 'running' | 'ok' | 'failed'
  failedStage?: string
  error?: string
  /** Duration outside every top-level stage. */
  unaccountedMs?: number
  context: TimingContext
  stages: TimingStage[]
  events: TimingEvent[]
  droppedEvents?: number
}
export interface TimingProbe {
  /** Cheap synchronous facts about the workspace and chat. */
  sample(): TimingFacts
  /** Kernel-side counts. Never awaited by an operation; may resolve late or not at all. */
  guest?(): Promise<TimingFacts | undefined>
}
export interface Spread { min: number; median: number; max: number; last: number }
export interface StageSummary {
  name: string
  depth: number
  /** Operations of this kind in which the stage occurred. */
  runs: number
  medianMs: number
  maxMs: number
  lastMs: number
  /** Median time not covered by nested stages; ranks stages without double counting. */
  exclusiveMedianMs: number
  /** exclusiveMedianMs as a fraction of the kind's median total. */
  share: number
}
export interface TimingSummary {
  version: 1
  generatedAt: string
  operations: number
  byKind: Record<string, { count: number; failed: number; totalMs?: Spread; unaccountedMs?: Spread; stages: StageSummary[] }>
  runs: { seq: number; kind: OperationKind; label: string; startedAt: string; sinceLoadMs: number; durationMs?: number; status: TimingOperation['status']; slowest: { name: string; ms: number }[]; context: TimingFacts }[]
  /** Fastest against slowest successful run of each kind: which stages and context differ. */
  variance: { kind: string; fastest: number; slowest: number; fastestMs: number; slowestMs: number; ratio: number; stages: { name: string; fastestMs: number; slowestMs: number; deltaMs: number }[]; context: Record<string, [unknown, unknown]> }[]
}

const maxOperations = 50, maxEvents = 500, maxStages = 250, maxUnattached = 200
const kinds: Record<string, OperationKind> = {
  'Open TODO workspace': 'open', 'Retry editor startup': 'open', 'Switch workspace': 'switch', 'New workspace': 'new-workspace',
  'Save workspace': 'save', 'Close editor': 'exit', 'Force close editor': 'force-exit',
  'Retry interrupted switch': 'retry-switch', 'Recover outgoing workspace': 'recover-switch',
}
// Log lines and guest output are not timings; heartbeats only repeat an open stage.
const ignored = /^(activity|guest\.output)$|\.waiting$/
const omittedKeys = new Set(['args', 'env', 'entry', 'cwd', 'stack', 'cause', 'headers', 'body'])
const milestones = new Set(['workspace.open', 'chat.connect'])
const round = (value: number) => Math.round(value * 10) / 10
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Bounded copy of an event payload: short scalars only, no launch arguments or stacks. */
function compact(value: unknown, depth = 0): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record(value)).slice(0, 16)) {
    if (omittedKeys.has(key) || item == null) continue
    if (typeof item === 'number' || typeof item === 'boolean') out[key] = item
    else if (typeof item === 'string') out[key] = item.slice(0, key === 'message' ? 300 : 160)
    else if (key === 'error') out.error = { name: record(item).name, message: String(record(item).message ?? item).slice(0, 300) }
    else if (Array.isArray(item)) { if (item.length <= 12 && item.every(entry => typeof entry === 'number')) out[key] = item }
    else if (depth < 1) { const nested = compact(item, depth + 1); if (nested) out[key] = nested }
  }
  return Object.keys(out).length ? out : undefined
}
function stageName(base: string, data: Record<string, unknown>): string {
  if (base === 'stage') return `step:${String(data.label ?? '')}`
  const suffix = typeof data.name === 'string' ? data.name : typeof data.path === 'string' ? `${String(data.method ?? 'GET')} ${data.path.split('?')[0]}` : undefined
  return suffix ? `${base}:${suffix}` : base
}
function spread(values: number[]): Spread | undefined {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1
  return { min: sorted[0]!, median: round(sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2), max: sorted.at(-1)!, last: values.at(-1)! }
}
function flatten(value: unknown, prefix = '', out: TimingFacts = {}): TimingFacts {
  for (const [key, item] of Object.entries(record(value))) {
    if (item && typeof item === 'object' && !Array.isArray(item)) flatten(item, prefix + key + '.', out)
    else if (item !== undefined) out[prefix + key] = item
  }
  return out
}
/** Per stage name: inclusive and exclusive (not covered by nested stages) time in one operation. */
function stageTotals(operation: TimingOperation): Map<string, { ms: number; exclusiveMs: number; depth: number }> {
  const totals = new Map<string, { ms: number; exclusiveMs: number; depth: number }>()
  for (const stage of operation.stages) {
    if (stage.durationMs === undefined) continue
    const total = totals.get(stage.name) ?? { ms: 0, exclusiveMs: 0, depth: stage.depth }
    total.ms = round(total.ms + stage.durationMs); total.exclusiveMs = round(total.exclusiveMs + (stage.selfMs ?? stage.durationMs))
    totals.set(stage.name, total)
  }
  return totals
}

export function createEditorTimings() {
  type OpenStage = { stage: TimingStage; base: string; childMs: number; parent?: OpenStage }
  type Active = { operation: TimingOperation; started: number; open: OpenStage[]; marks: Map<string, { stage: string; t: number }>; preview: Map<string, { attach: number; loaded?: number }>; lagTimer?: ReturnType<typeof setInterval>; hiddenAt?: number }
  let operations: TimingOperation[] = [], unattached: TimingEvent[] = []
  let active: Active | undefined, probe: TimingProbe | undefined
  let seq = 0, version = 0, kernelBoots = 0, runtimeStarts = 0, kernelSwControlled: boolean | undefined
  const swControlled = () => typeof navigator !== 'undefined' && navigator.serviceWorker ? !!navigator.serviceWorker.controller : undefined
  const counts = new Map<OperationKind, number>(), listeners = new Set<() => void>()
  const notify = () => { version++; for (const listener of listeners) listener() }

  function facts(): TimingFacts {
    const out: TimingFacts = {}
    try {
      out.swControlled = swControlled()
      if (typeof document !== 'undefined') out.visible = document.visibilityState === 'visible'
      const heap = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize
      if (typeof heap === 'number') out.jsHeapBytes = heap
      Object.assign(out, probe?.sample())
    } catch { /* context is best effort */ }
    return out
  }
  /** Fire-and-forget: a slow or wedged kernel only leaves these fields absent. */
  function lateFacts(target: TimingFacts, guest: boolean): void {
    try {
      if (typeof navigator !== 'undefined' && navigator.storage?.estimate) void navigator.storage.estimate().then(estimate => { target.storageUsageBytes = estimate.usage }, () => {})
      if (guest) void probe?.guest?.().then(counts => { if (counts) { target.guest = counts; notify() } }, () => {})
    } catch { /* context is best effort */ }
  }
  function addStage(run: Active, stage: TimingStage, parent: OpenStage | undefined): boolean {
    if (run.operation.stages.length >= maxStages) return false
    if (parent) { stage.parent = parent.stage.name; stage.depth = parent.stage.depth + 1; parent.childMs += stage.durationMs ?? 0 }
    run.operation.stages.push(stage)
    return true
  }
  function begin(label: string, runId: string | undefined, now: number): void {
    if (active) finish(active, now, { failed: true })
    const kind = kinds[label] ?? 'other', nthOfKind = (counts.get(kind) ?? 0) + 1
    counts.set(kind, nthOfKind)
    const start = facts()
    const operation: TimingOperation = {
      seq: ++seq, kind, label, runId, startedAt: new Date().toISOString(), sinceLoadMs: Math.round(now), status: 'running',
      context: { nthOfKind, kernel: start.workspaceOpen ? 'warm' : 'none', kernelCreatedSwControlled: start.workspaceOpen ? kernelSwControlled : undefined, kernelBootsInPage: kernelBoots, runtimeStartsInKernel: runtimeStarts, hiddenMs: 0, maxTimerLagMs: 0, start },
      stages: [], events: [],
    }
    const run: Active = { operation, started: now, open: [], marks: new Map(), preview: new Map() }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') run.hiddenAt = now
    let last = now
    run.lagTimer = setInterval(() => {
      const tick = performance.now()
      operation.context.maxTimerLagMs = Math.max(operation.context.maxTimerLagMs, Math.round(tick - last - 500)); last = tick
    }, 500)
    ;(run.lagTimer as unknown as { unref?(): void }).unref?.()
    lateFacts(start, kind !== 'force-exit')
    active = run
    operations.push(operation)
    if (operations.length > maxOperations) operations = operations.slice(-maxOperations)
    notify()
  }
  function finish(run: Active, now: number, data: Record<string, unknown>): void {
    const { operation } = run
    clearInterval(run.lagTimer)
    if (run.hiddenAt !== undefined) operation.context.hiddenMs += Math.round(now - run.hiddenAt)
    operation.endedAt = new Date().toISOString()
    operation.durationMs = round(now - run.started)
    operation.status = data.failed ? 'failed' : 'ok'
    // A step that threw has no closing event; whatever is still open ran until the end.
    for (const { stage } of run.open) { stage.durationMs = round(operation.durationMs - stage.startMs); if (data.failed) stage.status = 'failed' }
    operation.unaccountedMs = round(Math.max(0, operation.durationMs - operation.stages.reduce((sum, stage) => sum + (stage.depth === 0 ? stage.durationMs ?? 0 : 0), 0)))
    operation.context.kernelBootsInPage = kernelBoots; operation.context.runtimeStartsInKernel = runtimeStarts
    operation.context.end = facts()
    lateFacts(operation.context.end, true)
    active = undefined
    notify()
  }
  function closeStage(run: Active, name: string, t: number, status: 'ok' | 'failed', data: Record<string, unknown>): void {
    const { elapsedMs, name: _name, label: _label, path: _path, method: _method, error: _error, ...rest } = data
    const detail = compact(rest)
    const at = run.open.findLastIndex(entry => entry.stage.name === name)
    if (at < 0) {
      // Started before this operation, or beyond the stage bound: keep what the event knows.
      if (typeof elapsedMs === 'number') addStage(run, { name, startMs: round(Math.max(0, t - elapsedMs)), durationMs: elapsedMs, status, depth: 0, detail }, run.open.at(-1))
      return
    }
    const [entry] = run.open.splice(at, 1)
    const stage = entry!.stage
    stage.durationMs = round(t - stage.startMs); stage.status = status
    if (detail) stage.detail = { ...stage.detail, ...detail }
    if (entry!.childMs) stage.selfMs = round(Math.max(0, stage.durationMs - entry!.childMs))
    if (entry!.parent) entry!.parent.childMs += stage.durationMs
  }
  /** Facts that explain variance, read off events that pass through anyway. */
  function learn(run: Active, event: string, data: Record<string, unknown>): void {
    const { operation } = run, context = operation.context
    const sized = (patch: TimingFacts) => { context.workspace = { ...context.workspace, ...patch } }
    if (event === 'workspace.open' && data.stage === 'open.requested') { kernelBoots++; runtimeStarts = 0; context.kernel = 'cold' }
    // The kernel worker is constructed right after this milestone.
    else if (event === 'workspace.open' && data.stage === 'worker.create') context.kernelCreatedSwControlled = kernelSwControlled = swControlled()
    else if (event === 'opencode.readiness.health') context.openCodeHealthAttempts = Number(data.attempts)
    else if (event === 'runtime.start.start') runtimeStarts++
    else if (event === 'manifest.summary') context.manifest = compact(data)
    else if (event === 'editor.source') {
      context.storedState = data.initialized === true
      if (operation.kind === 'open') {
        counts.set('open', (counts.get('open') ?? 1) - 1)
        operation.kind = context.storedState ? 'reopen' : 'boot'
        counts.set(operation.kind, context.nthOfKind = (counts.get(operation.kind) ?? 0) + 1)
      }
    }
    else if (event === 'chat.connect' && data.stage === 'catalog') sized({ chatSessions: data.sessions, chatModels: data.models })
    else if (event === 'app.capture.source.ready') sized({ sourceFiles: data.files, sourceBytes: data.bytes })
    else if (event === 'app.capture.sessions.ready') sized({ sessions: data.sessions, sessionMessages: data.messages })
    else if (event === 'app.restore.sessions.ready') sized({ restoredSessions: data.sessions, restoredMessages: data.messages })
    else if (event === 'app.catalog.write.ready') sized({ catalogWorkspaces: data.workspaces, catalogSourceBytes: data.sourceBytes, catalogSessions: data.sessions })
  }
  function ingest(event: string, payload: unknown, runId?: string): void {
    if (ignored.test(event)) return
    const now = performance.now(), data = record(payload)
    if (event === 'operation.start') { begin(String(data.label ?? ''), runId, now); return }
    const run = active
    if (!run) {
      unattached.push({ t: Math.round(now), event, data: compact(data) })
      if (unattached.length > maxUnattached) unattached = unattached.slice(-maxUnattached)
      return
    }
    const { operation } = run, t = round(now - run.started)
    if (operation.events.length < maxEvents) operation.events.push({ t, event, data: compact(data) })
    else operation.droppedEvents = (operation.droppedEvents ?? 0) + 1
    learn(run, event, data)
    if (event === 'operation.failed') {
      if (typeof data.stage === 'string') operation.failedStage = data.stage
      operation.error = String(record(data.error).message ?? data.error ?? '').slice(0, 300)
      return
    }
    if (event === 'operation.end') { finish(run, now, data); return }
    // Preview: attach to first document load (includes service-worker registration),
    // then load to the application's own readiness check.
    const name = typeof data.name === 'string' ? data.name : ''
    if (event === 'preview.iframe.attach') { run.preview.set(name, { attach: t }); return }
    if (event === 'preview.iframe.loaded') {
      const preview = run.preview.get(name)
      if (preview && preview.loaded === undefined) { preview.loaded = t; addStage(run, { name: `preview.iframe.load:${name}`, startMs: preview.attach, durationMs: round(t - preview.attach), status: 'ok', depth: 0 }, run.open.at(-1)) }
      return
    }
    if (event === 'client.ready' || event === 'client.failed') {
      const preview = run.preview.get(name)
      if (preview?.loaded !== undefined) { addStage(run, { name: `preview.ready:${name}`, startMs: preview.loaded, durationMs: round(t - preview.loaded), status: event === 'client.ready' ? 'ok' : 'failed', depth: 0 }, run.open.at(-1)); run.preview.delete(name) }
      return
    }
    // Milestone streams become one stage per interval between consecutive milestones.
    if (milestones.has(event) && typeof data.stage === 'string') {
      const key = event + ':' + name, previous = run.marks.get(key)
      if (previous && !/requested$/.test(data.stage) && t - previous.t >= 1) addStage(run, { name: `${event}:${previous.stage}→${data.stage}`, startMs: previous.t, durationMs: round(t - previous.t), status: data.stage === 'open.failed' ? 'failed' : 'ok', depth: 0 }, run.open.at(-1))
      run.marks.set(key, { stage: data.stage, t })
      return
    }
    const bracket = /^(.+)\.(start|ready|failed)$/.exec(event)
    if (!bracket) return
    const base = bracket[1]!, stage = stageName(base, data)
    if (bracket[2] !== 'start') { closeStage(run, stage, t, bracket[2] === 'ready' ? 'ok' : 'failed', data); return }
    const parent = run.open.findLast(entry => entry.base !== base)
    const { name: _name, label: _label, path: _path, method: _method, ...rest } = data
    const opened: TimingStage = { name: stage, startMs: t, status: 'open', depth: 0, detail: compact(rest) }
    if (addStage(run, opened, parent)) run.open.push({ stage: opened, base, childMs: 0, parent })
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
    const run = active, now = performance.now()
    if (!run) return
    if (document.visibilityState === 'hidden') run.hiddenAt ??= now
    else if (run.hiddenAt !== undefined) { run.operation.context.hiddenMs += Math.round(now - run.hiddenAt); run.hiddenAt = undefined }
  })

  function summary(): TimingSummary {
    const byKind: TimingSummary['byKind'] = {}, variance: TimingSummary['variance'] = []
    const done = operations.filter(operation => operation.durationMs !== undefined)
    for (const kind of new Set(done.map(operation => operation.kind))) {
      const all = done.filter(operation => operation.kind === kind), ok = all.filter(operation => operation.status === 'ok')
      const totals = ok.map(stageTotals), totalMs = spread(ok.map(operation => operation.durationMs!))
      const stages: StageSummary[] = [...new Set(totals.flatMap(total => [...total.keys()]))].map(name => {
        const seen = totals.flatMap(total => total.get(name) ?? []), ms = spread(seen.map(entry => entry.ms))!, exclusive = spread(seen.map(entry => entry.exclusiveMs))!
        return { name, depth: seen[0]!.depth, runs: seen.length, medianMs: ms.median, maxMs: ms.max, lastMs: ms.last, exclusiveMedianMs: exclusive.median, share: totalMs?.median ? Math.round(exclusive.median / totalMs.median * 100) / 100 : 0 }
      }).sort((a, b) => b.exclusiveMedianMs - a.exclusiveMedianMs)
      byKind[kind] = { count: all.length, failed: all.length - ok.length, totalMs, unaccountedMs: spread(ok.map(operation => operation.unaccountedMs ?? 0)), stages }
      if (ok.length < 2) continue
      const ordered = [...ok].sort((a, b) => a.durationMs! - b.durationMs!), fastest = ordered[0]!, slowest = ordered.at(-1)!
      const fast = stageTotals(fastest), slow = stageTotals(slowest)
      const fastContext = flatten(fastest.context), slowContext = flatten(slowest.context)
      variance.push({
        kind, fastest: fastest.seq, slowest: slowest.seq, fastestMs: fastest.durationMs!, slowestMs: slowest.durationMs!, ratio: Math.round(slowest.durationMs! / Math.max(1, fastest.durationMs!) * 100) / 100,
        stages: [...new Set([...fast.keys(), ...slow.keys()])].map(name => {
          const fastestMs = fast.get(name)?.exclusiveMs ?? 0, slowestMs = slow.get(name)?.exclusiveMs ?? 0
          return { name, fastestMs, slowestMs, deltaMs: round(slowestMs - fastestMs) }
        }).sort((a, b) => Math.abs(b.deltaMs) - Math.abs(a.deltaMs)).slice(0, 10),
        context: Object.fromEntries([...new Set([...Object.keys(fastContext), ...Object.keys(slowContext)])].filter(key => fastContext[key] !== slowContext[key]).map(key => [key, [fastContext[key], slowContext[key]]])),
      })
    }
    return {
      version: 1, generatedAt: new Date().toISOString(), operations: operations.length, byKind, variance,
      runs: operations.map(operation => ({
        seq: operation.seq, kind: operation.kind, label: operation.label, startedAt: operation.startedAt, sinceLoadMs: operation.sinceLoadMs, durationMs: operation.durationMs, status: operation.status,
        slowest: [...stageTotals(operation)].map(([name, total]) => ({ name, ms: total.exclusiveMs })).sort((a, b) => b.ms - a.ms).slice(0, 5),
        context: flatten(operation.context),
      })),
    }
  }
  return {
    /** Sink for WorkspaceProvider/WorkspaceController `onDiagnostic`. */
    onDiagnostic(event: ControllerDiagnosticEvent): void { try { ingest(event.event, event.data, event.runId) } catch { /* timings must never break the editor */ } },
    /** Bracket one of this app's own steps. The task's result or rejection passes through. */
    async stage<T>(name: string, task: () => Promise<T>, detail?: (result: T) => TimingFacts | undefined): Promise<T> {
      const started = performance.now(), emit = (suffix: string, data?: TimingFacts) => { try { ingest(`app.${name}.${suffix}`, data) } catch { /* observation only */ } }
      emit('start')
      let result: T
      try { result = await task() }
      catch (error) { emit('failed', { elapsedMs: Math.round(performance.now() - started) }); throw error }
      let facts: TimingFacts | undefined
      try { facts = detail?.(result) } catch { /* observation only */ }
      emit('ready', { ...facts, elapsedMs: Math.round(performance.now() - started) })
      return result
    },
    setProbe(next: TimingProbe | undefined): () => void { probe = next; return () => { if (probe === next) probe = undefined } },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
    getVersion: () => version,
    get operations(): readonly TimingOperation[] { return operations },
    /** Events seen outside any operation, e.g. a close on unmount or a late preview load. */
    get unattached(): readonly TimingEvent[] { return unattached },
    summary,
    json(): string {
      return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), page: typeof location === 'undefined' ? undefined : location.origin + location.pathname, userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent, summary: summary(), operations, unattached }, null, 1)
    },
    clear(): void { operations = active ? [active.operation] : []; unattached = []; notify() },
  }
}
export type EditorTimings = ReturnType<typeof createEditorTimings>

/** One recorder per page: it outlives the editor, so exit and reopen stay comparable. */
export const editorTimings = createEditorTimings()
export const timedStage = editorTimings.stage

declare global { interface Window { __editorTimings?: Pick<EditorTimings, 'operations' | 'unattached' | 'summary' | 'json' | 'clear'> & { version: 1 } } }
if (typeof window !== 'undefined') window.__editorTimings = {
  version: 1,
  get operations() { return editorTimings.operations },
  get unattached() { return editorTimings.unattached },
  summary: editorTimings.summary, json: editorTimings.json, clear: editorTimings.clear,
}
