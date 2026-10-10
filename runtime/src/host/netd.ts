// netd: the bridge worker. It owns everything network-shaped that must not
// run on the page's main thread:
//   - requests from the service worker (preview frame → guest listener),
//     streamed both ways through transferred streams;
//   - WebSockets of the preview frame, spoken to the guest through the kernel
//     WebSocket codec;
//   - the image download into OPFS (before the kernel exists).
// It attaches its own kernel instance and is an ordinary kernel "host
// process" with its own event word, so preview traffic never waits for the
// page, and the page's endpoint fetches never wait for the preview.
import { attachKernel } from '../kernel/attach'
import { createKernel, type Kernel } from '../kernel/kernel'
import { createHttpClient, type HttpClient, type NetContext } from '../net/client'
import { wsConnect } from '../net/ws-client'
import type { FromNetd, ToNetd, WsFromNetd, WsToNetd } from './bridge-protocol'
import { collectImages, storeImage } from './image'
import { createReactor } from './reactor'

let kernel: Kernel | undefined
let ctx: NetContext | undefined
let client: HttpClient | undefined
const downloads = new Map<number, AbortController>()

function serve(port: MessagePort) {
  const inflight = new Map<number, AbortController>()
  const post = (m: FromNetd, transfer: Transferable[] = []) => port.postMessage(m, transfer)
  port.onmessage = (e: MessageEvent<ToNetd>) => {
    const m = e.data
    if (m.t === 'abort') return void inflight.get(m.id)?.abort()
    if (m.t === 'ws') return void serveWebSocket(m)
    if (m.t !== 'fetch') return
    const abort = new AbortController()
    inflight.set(m.id, abort)
    client!
      .request(m.port, { method: m.method, path: m.path, headers: m.headers, body: m.body, signal: abort.signal })
      .then(
        (res) => {
          // The stream is transferred; when the frame cancels it the connection closes.
          post({ t: 'response', id: m.id, status: res.status, statusText: res.statusText, headers: res.headers, body: res.body }, res.body ? [res.body as unknown as Transferable] : [])
        },
        (err) => post({ t: 'error', id: m.id, code: String(err?.code ?? err?.name ?? 'EFAIL'), message: String(err?.message ?? err) }),
      )
      .finally(() => inflight.delete(m.id))
  }
  ;(port as any).onclose = () => {
    for (const a of inflight.values()) a.abort()
  }
}

function serveWebSocket(m: Extract<ToNetd, { t: 'ws' }>) {
  const channel = m.channel
  const send = (msg: WsFromNetd, transfer: Transferable[] = []) => channel.postMessage(msg, transfer)
  const ws = wsConnect(ctx!, m.port, m.path, { protocols: m.protocols, headers: m.headers }, {
    open: (protocol, extensions) => send({ t: 'open', protocol, extensions }),
    message(data) {
      if (typeof data === 'string') send({ t: 'message', data })
      else {
        const buffer = data.buffer.byteLength === data.byteLength ? (data.buffer as ArrayBuffer) : (data.slice().buffer as ArrayBuffer)
        send({ t: 'message', data: buffer }, [buffer])
      }
    },
    error: (message) => send({ t: 'error', message }),
    close(code, reason, wasClean) {
      send({ t: 'close', code, reason, wasClean })
      channel.close()
    },
  })
  channel.onmessage = (e: MessageEvent<WsToNetd>) => {
    const d = e.data
    if (d.t === 'send') ws.send(typeof d.data === 'string' ? d.data : new Uint8Array(d.data))
    else if (d.t === 'close') ws.close(d.code, d.reason)
  }
  // The frame navigated away or was removed without closing its sockets.
  ;(channel as any).onclose = () => ws.destroy()
}

const ops: Record<string, (a: any, id: number) => unknown> = {
  async storeImage(a, id) {
    const abort = new AbortController()
    downloads.set(id, abort)
    try {
      return await storeImage(a, (loaded, total) => postMessage({ id, progress: { loaded, total } }), abort.signal)
    } finally {
      downloads.delete(id)
    }
  },
  cancel(a: { id: number }) {
    downloads.get(a.id)?.abort()
  },
  collectImages: (a: { namespace: string; keep: string }) => collectImages(a.namespace, a.keep),
  async attach(a: { module: WebAssembly.Module; memory: WebAssembly.Memory }) {
    const inst = await attachKernel({ module: a.module, memory: a.memory, canBlock: true })
    kernel = createKernel(inst)
    const pid: number = kernel.x.bat_host_proc_new()
    ctx = { kernel, io: createReactor(kernel) }
    client = createHttpClient(ctx)
    return { pid, thread: inst.thread }
  },
  /** A new service worker instance (first registration, update, or restart after idle). */
  port(a: { port: MessagePort }) {
    serve(a.port)
  },
  close() {
    client?.close()
  },
}

self.onmessage = async (e: MessageEvent) => {
  const { id, op, args } = e.data
  try {
    postMessage({ id, ok: true, value: await ops[op](args, id) })
  } catch (err) {
    postMessage({ id, ok: false, error: String((err as Error)?.message ?? err), code: (err as any)?.code, name: (err as any)?.name })
  }
}
