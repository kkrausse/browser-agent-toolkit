// What this page sees, in two places.
//
// A collector, so a failure on someone else's device can be read afterwards: start-up stages,
// errors, the OpenCode server's output and the terminal's screen are posted to it.
// `?diag=<url>` names the collector (default: the one the page was built with, else this host,
// port 4311, mock-model.ts); `?diag=0` turns it off. A page built with no collector at all
// (`built` null: the public build) sends nothing unless its address names one.
//
// A panel on the page itself, for a device with no console (a phone): `?diag=1`, or always in
// a build made with `DIAG_PANEL=1` (`?panel=0` hides it there). It shows the browser, whether
// the page is isolated, what storage answers, every start-up stage with its time (the page's
// own, the runtime's boot marks and its trace marks from every thread), the last error with
// its stack, uncaught errors, unhandled rejections, worker crashes and the last log lines,
// and has a button that copies all of it as text. Once the terminal is up and nothing has
// failed it folds itself into a button in the corner. The readout is also kept in localStorage as
// it changes, so that a tab the browser killed shows what it had reached when it is opened
// again ("previous load"). Nothing of the panel is sent anywhere.
export interface Diag {
  event(kind: string, data?: unknown): void
  /** Sends the screen whenever it has changed. */
  watchScreen(screen: () => string[]): void
  /** The on-page panel is shown: the caller may ask the runtime for its trace marks. */
  readonly panel: boolean
}

const text = (value: unknown, limit = 2000): string => {
  if (value instanceof Error) {
    let out = `${value.name}: ${value.message}\n${value.stack ?? ''}`
    // The runtime wraps what it was told by a worker or the browser: the first cause is the fact.
    for (let cause = (value as { cause?: unknown }).cause, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) out += `\ncaused by: ${cause instanceof Error ? `${cause.name}: ${cause.message}\n${cause.stack ?? ''}` : String(cause)}`
    return out.slice(0, limit)
  }
  if (typeof value === 'string') return value.slice(0, limit)
  try { return (JSON.stringify(value) ?? String(value)).slice(0, limit) } catch { return String(value).slice(0, limit) }
}

const isPanel = (given: string | null) => given === '1' || given === 'panel'

export function installDiag(params: URLSearchParams, built?: string | null, panelBuilt = false): Diag {
  const given = params.get('diag')
  const url = given === '0' ? null : given && !isPanel(given) ? given : built === null ? null : built ?? `${location.protocol}//${location.hostname}:4311/diag`
  const panel = (isPanel(given) || panelBuilt) && params.get('panel') !== '0' ? installPanel() : undefined
  const id = Math.random().toString(36).slice(2, 8)
  let queue: unknown[] = [], timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    timer = undefined
    if (!url || !queue.length) return
    const body = JSON.stringify(queue)
    queue = []
    // text/plain: no preflight.
    void fetch(url, { method: 'POST', body, headers: { 'content-type': 'text/plain' }, keepalive: body.length < 60000 }).catch(() => {})
  }
  const event = (kind: string, data?: unknown) => {
    panel?.event(kind, data)
    if (!url) return
    queue.push({ id, t: Math.round(performance.now()), kind, data: data instanceof Error ? text(data) : data })
    timer ??= setTimeout(flush, 500)
  }
  event('start', { href: location.href, userAgent: navigator.userAgent, isolated: crossOriginIsolated, viewport: [innerWidth, innerHeight], touch: navigator.maxTouchPoints })
  window.addEventListener('error', e => event('error', e.error instanceof Error ? e.error : `${e.message} (${e.filename}:${e.lineno}:${e.colno})`))
  window.addEventListener('unhandledrejection', e => event('rejection', e.reason instanceof Error ? e.reason : text(e.reason)))
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => { event('console.' + level, args.map(arg => text(arg)).join(' ')); original(...args) }
  }
  window.addEventListener('pagehide', flush)
  return {
    event,
    panel: !!panel,
    watchScreen(screen) {
      let last = ''
      setInterval(() => {
        let now = ''
        try { now = screen().map(line => line.trimEnd()).join('\n').trim() } catch (error) { now = 'screen() failed: ' + text(error) }
        if (now !== last) { last = now; panel?.screen(now); if (url) event('screen', now) }
      }, 2000)
    },
  }
}

/** What the runtime's threads say on their trace channel (runtime/src/trace.ts), and on the
 * channel its supervisor reports failures of its workers on (runtime/src/kernel/kerneld.ts). */
const traceChannel = 'bat-trace', reportChannel = 'bat-diag'
const lastKey = 'terminal-app-diag-last', loadsKey = 'terminal-app-diag-loads'

interface Line { t: number; kind: string; text: string }

function installPanel(): { event(kind: string, data?: unknown): void; screen(text: string): void } {
  const started = new Date()
  const ms = (t: number) => `${String(Math.round(t)).padStart(6)} ms`
  const mib = (bytes: number | undefined) => bytes === undefined ? '?' : `${(bytes / 1048576).toFixed(1)} MiB`
  const stages: Line[] = [], errors: Line[] = [], warnings: Line[] = [], logs: Line[] = [], marks: Line[] = []
  const facts: Record<string, string> = {}
  let lastError: Line | undefined, screenText = '', traceTotal = 0
  let previous = ''
  try { previous = localStorage.getItem(lastKey) ?? '' } catch { /* no storage */ }
  // How often this tab has loaded the page: a tab that the browser kills and reloads counts up.
  let loads = 1
  try { loads = Number(sessionStorage.getItem(loadsKey) ?? 0) + 1; sessionStorage.setItem(loadsKey, String(loads)) } catch { /* no storage */ }

  const push = (list: Line[], kind: string, value: unknown, limit: number) => {
    const line = { t: performance.now(), kind, text: text(value, 4000) }
    list.push(line)
    if (list.length > limit) list.shift()
    changed()
    return line
  }
  const problem = (kind: string, value: unknown) => { lastError = push(errors, kind, value, 60) }

  // --- the panel itself: a sheet at the bottom of the page, over everything.
  const root = document.createElement('section')
  root.id = 'diag'
  root.setAttribute('aria-label', 'Diagnostics')
  root.innerHTML = `<style>
    #diag { position: fixed; left: 0; right: 0; bottom: 0; z-index: 20; display: flex; flex-direction: column; max-height: 55vh; background: #0d0d12f2; color: #c8c5b4; border-top: 1px solid #54546d; font: 11px/1.4 ui-monospace, Menlo, monospace; }
    #diag.small { left: auto; right: 6px; bottom: 6px; border: 1px solid #54546d; border-radius: 6px; }
    #diag.small > pre, #diag.small > textarea, #diag.small .wide { display: none; }
    #diag > header { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding: 5px 8px; }
    #diag > header b { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: #dcd7ba; }
    #diag > header b.bad { color: #e06c75; }
    #diag button { font: inherit; padding: 5px 10px; }
    #diag > pre { flex: 1 1 auto; min-height: 0; margin: 0; padding: 0 8px 8px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; -webkit-user-select: text; user-select: text; }
    #diag > textarea { flex: 0 0 30vh; margin: 0 8px 8px; font: inherit; color: inherit; background: #16161d; border: 1px solid #54546d; }
    #diag > textarea[hidden] { display: none; }
  </style>
  <header><b></b><button type="button" name="copy" class="wide">Copy all</button><button type="button" name="toggle">Hide</button></header>
  <pre></pre><textarea readonly hidden aria-label="The readout as text, to select and copy by hand"></textarea>`
  const headline = root.querySelector('b')!, body = root.querySelector('pre')!, manual = root.querySelector('textarea')!
  const toggle = root.querySelector<HTMLButtonElement>('button[name="toggle"]')!, copy = root.querySelector<HTMLButtonElement>('button[name="copy"]')!
  const attach = () => document.body.append(root)
  if (document.body) attach(); else addEventListener('DOMContentLoaded', attach)
  // Open while the page starts, out of the way once it has (unless something failed, or it was touched).
  let touched = false
  const small = (on: boolean) => { root.classList.toggle('small', on); toggle.textContent = on ? 'Diagnostics' : 'Hide'; render() }
  toggle.addEventListener('click', () => { touched = true; small(!root.classList.contains('small')) })
  copy.addEventListener('click', () => {
    const all = readout(true)
    const shown = (label: string) => { copy.textContent = label; setTimeout(() => { copy.textContent = 'Copy all' }, 2500) }
    // Where the clipboard cannot be written (no permission, an old browser): the text in a field, selected.
    const byHand = () => {
      manual.hidden = false
      manual.value = all
      manual.focus()
      manual.select()
      manual.setSelectionRange(0, all.length)
      let done = false
      try { done = document.execCommand('copy') } catch { /* not allowed */ }
      shown(done ? 'Copied' : 'Select all, copy')
      if (done) manual.hidden = true
    }
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(all).then(() => shown(`Copied ${all.length} chars`), byHand)
    else byHand()
  })

  // --- what is asked once.
  const fact = (name: string, value: string) => { facts[name] = value; changed() }
  const estimate = () => {
    if (!navigator.storage?.estimate) return fact('storage.estimate', 'not offered')
    void navigator.storage.estimate().then(e => fact('storage.estimate', `usage ${mib(e.usage)}, quota ${mib(e.quota)}`), e => fact('storage.estimate', `failed: ${text(e, 300)}`))
  }
  estimate()
  setInterval(estimate, 15_000)
  void navigator.storage?.persisted?.().then(p => fact('storage.persisted', String(p)), e => fact('storage.persisted', `failed: ${text(e, 300)}`))
  // Can a worker of this page open a sync access handle in the origin's private file system?
  // The runtime's supervisor needs that; asked here apart from it, on a file of this probe's own.
  const probe = `onmessage = async () => { const t = performance.now(); try {
    const d = await navigator.storage.getDirectory(); const f = await d.getFileHandle('diag-probe', { create: true });
    const h = await f.createSyncAccessHandle(); const n = h.write(new Uint8Array(4096), { at: 0 }); h.flush(); const size = h.getSize(); h.close();
    await d.removeEntry('diag-probe').catch(() => {});
    postMessage('ok: created, wrote ' + n + ' bytes, size ' + size + ', ' + Math.round(performance.now() - t) + ' ms');
  } catch (e) { postMessage('FAILED: ' + (e && e.name) + ': ' + (e && e.message)) } }`
  const native = window.Worker
  try {
    const address = URL.createObjectURL(new Blob([probe], { type: 'text/javascript' }))
    const worker = new native(address)
    const end = (value: string) => { fact('opfs sync handle (probe)', value); worker.terminate(); URL.revokeObjectURL(address) }
    worker.onmessage = e => end(String(e.data))
    worker.onerror = e => end(`FAILED: the probe worker did not run: ${e.message}`)
    setTimeout(() => { if (!facts['opfs sync handle (probe)']) end('no answer in 10 s') }, 10_000)
    worker.postMessage(0)
  } catch (error) { fact('opfs sync handle (probe)', `FAILED: ${text(error, 300)}`) }

  // --- what the page cannot be told by its own code: workers it creates that die.
  window.Worker = new Proxy(native, {
    construct(target, args: ConstructorParameters<typeof Worker>) {
      const worker = new target(...args)
      const name = args[1]?.name || String(args[0]).split('/').pop()?.split('?')[0] || 'worker'
      worker.addEventListener('error', e => problem('worker error', `${name}: ${e.message || '(no message: the script failed to load, or the worker was killed)'} ${e.filename ?? ''}:${e.lineno ?? ''}`))
      worker.addEventListener('messageerror', () => problem('worker messageerror', name))
      push(stages, 'worker', `created ${name}`, 300)
      return worker
    },
  })
  // The runtime's boot phases, always marked (runtime/src/host/host.ts): the detail has the
  // sub-timings and, once the kernel is up, the size of its memory.
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (!entry.name.startsWith('bat:')) continue
        const detail = (entry as PerformanceMark).detail as Record<string, number | boolean> | null
        if (typeof detail?.kernelMemoryBytes === 'number') facts['kernel memory'] = `allocated: ${mib(detail.kernelMemoryBytes)} shared${detail.kernelMemoryFixed === false ? ', growable' : ', fixed'}`
        const line = { t: entry.startTime, kind: 'runtime', text: `${entry.name.slice(4)}${detail ? ' ' + text(Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v) : v])), 600) : ''}` }
        stages.push(line)
      }
      stages.sort((a, b) => a.t - b.t)
      changed()
    }).observe({ type: 'mark', buffered: true })
  } catch { /* no user timing */ }
  // Every thread's trace marks, when the page asked the runtime for them.
  try {
    const channel = new BroadcastChannel(traceChannel)
    channel.onmessage = e => {
      const mark = e.data as { src?: string; name?: string; t?: number; data?: unknown }
      if (!mark?.name) return
      traceTotal++
      marks.push({ t: (mark.t ?? 0) - performance.timeOrigin, kind: mark.src ?? '', text: `${mark.name}${mark.data === undefined ? '' : ' ' + text(mark.data, 120)}` })
      if (marks.length > 400) marks.shift()
      changed()
    }
    const reports = new BroadcastChannel(reportChannel)
    reports.onmessage = e => problem(`runtime ${(e.data as { src?: string })?.src ?? ''}`.trim(), (e.data as { text?: string })?.text ?? e.data)
  } catch { /* no BroadcastChannel */ }
  addEventListener('pagehide', e => { push(stages, 'page', `pagehide${(e as PageTransitionEvent).persisted ? ' (kept by the browser)' : ''}`, 300); save() })
  document.addEventListener('visibilitychange', () => push(stages, 'page', `visibility ${document.visibilityState}`, 300))
  navigator.serviceWorker?.addEventListener('controllerchange', () => push(stages, 'page', 'service worker controller changed', 300))

  // --- the readout.
  const lines = (list: Line[], last?: number) => (last ? list.slice(-last) : list).map(line => `${ms(line.t)}  ${line.kind ? `[${line.kind}] ` : ''}${line.text}`)
  function readout(full: boolean): string {
    const memory = (performance as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory
    const controller = navigator.serviceWorker?.controller
    const out = [
      `diagnostics of ${location.href}`,
      `loaded ${started.toISOString()}, now +${Math.round(performance.now())} ms, load ${loads} of this tab`,
      `user agent: ${navigator.userAgent}`,
      `platform: ${navigator.platform}, touch points ${navigator.maxTouchPoints}, cores ${navigator.hardwareConcurrency ?? '?'}, deviceMemory ${(navigator as { deviceMemory?: number }).deviceMemory ?? '?'}, viewport ${innerWidth}x${innerHeight} @${devicePixelRatio}, standalone ${(navigator as { standalone?: boolean }).standalone ?? 'n/a'}`,
      `crossOriginIsolated: ${crossOriginIsolated}, secure context: ${isSecureContext}, SharedArrayBuffer: ${typeof SharedArrayBuffer}, Atomics.waitAsync: ${typeof (Atomics as { waitAsync?: unknown }).waitAsync}, DecompressionStream: ${typeof DecompressionStream}`,
      `service worker: ${!('serviceWorker' in navigator) ? 'not offered' : controller ? `controls the page (${controller.state}, ${controller.scriptURL.split('/').pop()})` : 'does not control the page'}`,
      ...Object.entries(facts).map(([name, value]) => `${name}: ${value}`),
      ...(facts['kernel memory'] ? [] : ['kernel memory: not allocated yet (or the runtime never got that far)']),
      ...(memory ? [`js heap: ${mib(memory.usedJSHeapSize)} of ${mib(memory.jsHeapSizeLimit)}`] : []),
      '',
      `LAST ERROR: ${lastError ? `+${Math.round(lastError.t)} ms [${lastError.kind}]\n${lastError.text}` : 'none'}`,
      '',
      `STAGES (${stages.length})`,
      ...lines(stages),
      '',
      `ERRORS, REJECTIONS, WORKER CRASHES, console.error (${errors.length})`,
      ...lines(errors, full ? undefined : 8),
      '',
      `WARNINGS (${warnings.length})`,
      ...lines(warnings, full ? undefined : 4),
      '',
      `LOG (last ${full ? 80 : 12} of ${logs.length})`,
      ...lines(logs, full ? 80 : 12),
      '',
      `RUNTIME TRACE (last ${full ? Math.min(marks.length, 400) : Math.min(marks.length, 15)} of ${traceTotal})`,
      ...lines(marks, full ? 400 : 15),
    ]
    if (full) out.push('', 'TERMINAL SCREEN', screenText || '(nothing drawn)')
    if (previous) out.push('', `PREVIOUS LOAD OF THIS PAGE IN THIS BROWSER (what it had reached; ${full ? 'whole' : 'its head, Copy all has the rest'})`, full ? previous : previous.split('\n').slice(0, 14).join('\n'))
    return out.join('\n')
  }
  // Kept as it changes: a tab the system kills says nothing on the way out.
  const save = () => {
    try { localStorage.setItem(lastKey, readout(true).split('\nPREVIOUS LOAD OF THIS PAGE')[0]!.slice(0, 60_000)) } catch { /* no storage, or full */ }
  }
  let pending: ReturnType<typeof setTimeout> | undefined, saved = 0
  function render() {
    pending = undefined
    const failed = stages.findLast(line => line.kind === 'failed')
    const stage = stages.findLast(line => line.kind === 'stage' || line.kind === 'failed')
    headline.textContent = `diag · ${failed ? 'FAILED' : stage?.text.slice(0, 60) ?? 'starting'}${errors.length ? ` · ${errors.length} error(s)` : ''}`
    headline.classList.toggle('bad', !!failed || errors.length > 0)
    if (!root.classList.contains('small')) {
      const pinned = body.scrollTop < 4
      body.textContent = readout(false)
      if (pinned) body.scrollTop = 0
    }
    if (performance.now() - saved > 2000) { saved = performance.now(); save() }
  }
  function changed() { pending ??= setTimeout(render, 250) }
  changed()
  setInterval(save, 5000)

  return {
    event(kind, data) {
      if (kind === 'stage') {
        push(stages, 'stage', data, 300)
        if (data === 'terminal mounted' && !touched && !errors.length) small(true)
      }
      else if (kind === 'failed') { push(stages, 'failed', data instanceof Error ? data.message : data, 300); problem('failed', data) }
      else if (kind === 'log') push(logs, '', data, 400)
      else if (kind === 'console.warn') push(warnings, '', data, 60)
      else if (kind === 'start' || kind === 'screen') { /* shown from the page itself */ }
      else problem(kind, data)
    },
    screen(now) { screenText = now },
  }
}
