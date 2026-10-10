// What this page sees, sent to a collector so a failure on someone else's device can be read
// afterwards: start-up stages, errors, the OpenCode server's output and the terminal's screen.
// `?diag=<url>` names the collector (default: this host, port 4311, mock-model.ts); `?diag=0` turns it off.
export interface Diag {
  event(kind: string, data?: unknown): void
  /** Sends the screen whenever it has changed. */
  watchScreen(screen: () => string[]): void
}

export function installDiag(params: URLSearchParams): Diag {
  const given = params.get('diag')
  const url = given === '0' ? null : given ?? `${location.protocol}//${location.hostname}:4311/diag`
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
    if (!url) return
    queue.push({ id, t: Math.round(performance.now()), kind, data })
    timer ??= setTimeout(flush, 500)
  }
  const text = (value: unknown) => (value instanceof Error ? `${value.name}: ${value.message}\n${value.stack ?? ''}` : typeof value === 'string' ? value : (() => { try { return JSON.stringify(value) } catch { return String(value) } })()).slice(0, 2000)
  event('start', { href: location.href, userAgent: navigator.userAgent, isolated: crossOriginIsolated, viewport: [innerWidth, innerHeight], touch: navigator.maxTouchPoints })
  window.addEventListener('error', e => event('error', text(e.error ?? e.message)))
  window.addEventListener('unhandledrejection', e => event('rejection', text(e.reason)))
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => { event('console.' + level, args.map(text).join(' ')); original(...args) }
  }
  window.addEventListener('pagehide', flush)
  return {
    event,
    watchScreen(screen) {
      let last = ''
      setInterval(() => {
        let now = ''
        try { now = screen().map(line => line.trimEnd()).join('\n').trim() } catch (error) { now = 'screen() failed: ' + text(error) }
        if (now !== last) event('screen', last = now)
      }, 2000)
    },
  }
}
