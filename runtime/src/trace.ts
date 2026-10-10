// Startup tracing, off unless asked for (`bootRuntime({ trace: true })`, or
// `localStorage['bat-trace'] = '1'` on the page). Every thread of the runtime posts
// `{ src, name, t, data? }` on one BroadcastChannel, `t` in epoch milliseconds
// (timeOrigin + now), and the page keeps what arrives in `globalThis.__batTrace`.
// Off, a mark is one test of a variable. bench/startup reads the result.
export const TRACE_CHANNEL = 'bat-trace'
export interface TraceMark {
  src: string
  name: string
  t: number
  data?: unknown
}

let channel: BroadcastChannel | undefined
let source = ''

export function traceEnable(src: string): void {
  source = src
  channel ??= new BroadcastChannel(TRACE_CHANNEL)
}
export const tracing = (): boolean => channel !== undefined
export function trace(name: string, data?: unknown, at?: number): void {
  if (channel) channel.postMessage({ src: source, name, t: performance.timeOrigin + (at ?? performance.now()), data } satisfies TraceMark)
}

/** Page: collect every thread's marks (its own included) into `globalThis.__batTrace`. */
export function traceCollect(src: string): () => void {
  traceEnable(src)
  const store: TraceMark[] = ((globalThis as any).__batTrace ??= [])
  const listener = new BroadcastChannel(TRACE_CHANNEL)
  listener.onmessage = (e) => store.push(e.data)
  return () => listener.close()
}
