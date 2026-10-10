// Runs inside the preview frame, injected by the service worker at the top of
// every HTML document it serves. A service worker cannot intercept a
// WebSocket upgrade, so `WebSocket` is replaced: sockets to this origin under
// `/preview/<port>/` are carried over a MessageChannel to the bridge worker,
// which speaks the WebSocket protocol to the guest listener through the
// kernel codec. Every other URL gets the native class. `EventSource` needs no
// shim: its requests are ordinary fetches the service worker streams.
//
// This function is serialised with `toString()` into the page, so it must not
// reference anything outside its own body.
export function previewShim(): void {
  const w = globalThis as any
  if (w.__batPreviewShim) return
  w.__batPreviewShim = true
  const Native: typeof WebSocket = w.WebSocket
  const guestPath = /^\/preview\/\d+(\/|$)/
  const CONNECTING = 0
  const OPEN = 1
  const CLOSING = 2
  const CLOSED = 3

  class GuestSocket extends EventTarget {
    _url: string
    _state = CONNECTING
    _protocol = ''
    _extensions = ''
    _buffered = 0
    _binaryType: BinaryType = 'blob'
    _port: MessagePort
    _order: Promise<void> = Promise.resolve()
    onopen: ((e: Event) => void) | null = null
    onmessage: ((e: MessageEvent) => void) | null = null
    onerror: ((e: Event) => void) | null = null
    onclose: ((e: CloseEvent) => void) | null = null

    constructor(url: URL, protocols: string[]) {
      super()
      this._url = url.href
      const channel = new MessageChannel()
      this._port = channel.port1
      this._port.onmessage = (e) => this._receive(e.data)
      const message = { t: 'bat-ws', url: url.href, protocols, channel: channel.port2 }
      const controller = navigator.serviceWorker.controller
      if (controller) controller.postMessage(message, [channel.port2])
      else {
        navigator.serviceWorker.ready.then(
          (registration) => registration.active!.postMessage(message, [channel.port2]),
          () => this._receive({ t: 'close', code: 1006, reason: '', wasClean: false }),
        )
      }
      addEventListener('pagehide', () => {
        if (this._state !== CLOSED) this._port.postMessage({ t: 'close', code: 1001, reason: '' })
      })
    }
    _emit(name: 'open' | 'message' | 'error' | 'close', event: Event) {
      const handler = (this as any)[`on${name}`]
      if (typeof handler === 'function') {
        try {
          handler.call(this, event)
        } catch (e) {
          setTimeout(() => {
            throw e
          })
        }
      }
      this.dispatchEvent(event)
    }
    _receive(m: any) {
      if (this._state === CLOSED) return
      if (m.t === 'open') {
        this._state = OPEN
        this._protocol = m.protocol
        this._extensions = m.extensions
        this._emit('open', new Event('open'))
      } else if (m.t === 'message') {
        const data = typeof m.data === 'string' || this._binaryType === 'arraybuffer' ? m.data : new Blob([m.data])
        this._emit('message', new MessageEvent('message', { data, origin: new URL(this._url).origin }))
      } else if (m.t === 'error') {
        this._emit('error', new Event('error'))
      } else if (m.t === 'close') {
        const failed = this._state === CONNECTING
        this._state = CLOSED
        this._port.close()
        if (failed) this._emit('error', new Event('error'))
        this._emit('close', new CloseEvent('close', { code: m.code, reason: m.reason, wasClean: m.wasClean }))
      }
    }
    get url() {
      return this._url
    }
    get readyState() {
      return this._state
    }
    get bufferedAmount() {
      return this._buffered
    }
    get extensions() {
      return this._extensions
    }
    get protocol() {
      return this._protocol
    }
    get binaryType() {
      return this._binaryType
    }
    set binaryType(v: BinaryType) {
      if (v === 'blob' || v === 'arraybuffer') this._binaryType = v
    }
    send(data: string | ArrayBufferLike | ArrayBufferView | Blob) {
      if (this._state === CONNECTING) throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError')
      if (this._state !== OPEN) return
      if (typeof data === 'string') {
        this._order = this._order.then(() => this._port.postMessage({ t: 'send', data }))
      } else if (data instanceof Blob) {
        const bytes = data.arrayBuffer()
        this._order = this._order.then(async () => {
          const buffer = await bytes
          this._port.postMessage({ t: 'send', data: buffer }, [buffer])
        })
      } else {
        const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data as ArrayBuffer)
        const buffer = view.slice().buffer
        this._order = this._order.then(() => this._port.postMessage({ t: 'send', data: buffer }, [buffer]))
      }
    }
    close(code?: number, reason?: string) {
      if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) {
        throw new DOMException(`Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. ${code} is neither.`, 'InvalidAccessError')
      }
      if (this._state === CLOSING || this._state === CLOSED) return
      this._state = CLOSING
      this._order = this._order.then(() => this._port.postMessage({ t: 'close', code, reason }))
    }
  }
  for (const [name, value] of [['CONNECTING', CONNECTING], ['OPEN', OPEN], ['CLOSING', CLOSING], ['CLOSED', CLOSED]] as const) {
    Object.defineProperty(GuestSocket.prototype, name, { value, enumerable: true })
  }
  // `socket instanceof WebSocket` holds for both kinds.
  Object.setPrototypeOf(GuestSocket.prototype, Native.prototype)

  const Replacement = function WebSocket(this: unknown, url: string | URL, protocols?: string | string[]) {
    if (!new.target) throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator, this DOM object constructor cannot be called as a function.")
    let parsed: URL | undefined
    try {
      parsed = new URL(String(url), location.href)
    } catch {
      // the native constructor reports it
    }
    if (parsed) {
      if (parsed.protocol === 'http:') parsed.protocol = 'ws:'
      else if (parsed.protocol === 'https:') parsed.protocol = 'wss:'
    }
    if (parsed && (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') && parsed.host === location.host && guestPath.test(parsed.pathname)) {
      const list = protocols === undefined ? [] : Array.isArray(protocols) ? protocols.map(String) : [String(protocols)]
      return new GuestSocket(parsed, list)
    }
    return protocols === undefined ? new Native(url) : new Native(url, protocols)
  } as unknown as typeof WebSocket
  Replacement.prototype = Native.prototype
  for (const [name, value] of [['CONNECTING', CONNECTING], ['OPEN', OPEN], ['CLOSING', CLOSING], ['CLOSED', CLOSED]] as const) {
    Object.defineProperty(Replacement, name, { value, enumerable: true })
  }
  w.WebSocket = Replacement
  // A SharedWorker has its own global: the replacement above does not exist there, and a
  // socket it opens to the guest would go to the real server. Vite's client waits for a
  // restarted dev server from a SharedWorker made of a blob (`new WebSocket(url,
  // 'vite-ping')`), so after a `vite.config.ts` change the frame polled the wrong server for
  // ever and was never reloaded. Without the class the client pings from the page instead.
  try {
    Object.defineProperty(w, 'SharedWorker', { value: undefined, configurable: true, writable: true })
  } catch {
    // left as it is
  }
}
