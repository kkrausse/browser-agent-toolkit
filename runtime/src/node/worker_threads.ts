// `node:worker_threads`. MessageChannel/MessagePort are implemented here, in
// the process's own event loop, rather than on the browser's: a Node port has
// `on('message')`, keeps the process alive while it listens, and can be read
// synchronously (`receiveMessageOnPort`), none of which a browser port does.
// `Worker` is not provided yet.
import type { Runtime } from '../process/runtime'
import { registerBuiltin, unsupported } from './registry'

function create(rt: Runtime): any {
  const EventEmitter = rt.require('events')
  const loop = rt.loop
  const g = rt.host.global
  const env = new Map<unknown, unknown>()
  const untransferable = new WeakSet<object>()

  class MessagePort extends EventEmitter {
    _other: MessagePort | undefined
    _queue: unknown[] = []
    _started = false
    _closed = false
    _refed = false
    _scheduled = false
    _onmessage: ((ev: unknown) => void) | null = null
    _wrapped = new Map<unknown, (data: unknown) => void>()
    constructor() {
      super()
      this.on('newListener', (name: string) => {
        if (name === 'message') {
          this.start()
          this.ref()
        }
      })
      this.on('removeListener', (name: string) => {
        if (name === 'message' && this.listenerCount('message') === 0) this.unref()
      })
    }
    postMessage(value: unknown, transfer?: unknown) {
      const other = this._other
      if (this._closed || !other || other._closed) return
      const list = (Array.isArray(transfer) ? transfer : (transfer as any)?.transfer ?? []).filter((t: unknown) => !(t instanceof MessagePort))
      other._queue.push(g.structuredClone(value, list.length ? { transfer: list } : undefined))
      other._schedule()
    }
    _schedule() {
      if (!this._started || this._scheduled || this._closed) return
      this._scheduled = true
      loop.setImmediate(() => {
        this._scheduled = false
        while (this._queue.length && this._started && !this._closed) this.emit('message', this._queue.shift())
      })
    }
    start() {
      if (!this._started) {
        this._started = true
        this._schedule()
      }
    }
    close(cb?: () => void) {
      if (this._closed) return
      this._closed = true
      this.unref()
      const other = this._other
      if (typeof cb === 'function') this.once('close', cb)
      loop.setImmediate(() => this.emit('close'))
      if (other && !other._closed) other.close()
    }
    ref() {
      if (!this._refed && !this._closed) {
        this._refed = true
        loop.ref()
      }
    }
    unref() {
      if (this._refed) {
        this._refed = false
        loop.unref()
      }
    }
    hasRef() {
      return this._refed
    }
    get onmessage() {
      return this._onmessage
    }
    set onmessage(fn: ((ev: unknown) => void) | null) {
      if (this._onmessage) this.removeEventListener('message', this._onmessage)
      this._onmessage = typeof fn === 'function' ? fn : null
      if (this._onmessage) this.addEventListener('message', this._onmessage)
    }
    addEventListener(type: string, fn: any) {
      if (typeof fn !== 'function' && typeof fn?.handleEvent !== 'function') return
      if (this._wrapped.has(fn)) return
      const wrapped = (data: unknown) => {
        const ev = type === 'message' ? new g.MessageEvent('message', { data }) : new g.Event(type)
        if (typeof fn === 'function') fn.call(this, ev)
        else fn.handleEvent(ev)
      }
      this._wrapped.set(fn, wrapped)
      this.on(type, wrapped)
    }
    removeEventListener(type: string, fn: any) {
      const wrapped = this._wrapped.get(fn)
      if (wrapped) {
        this._wrapped.delete(fn)
        this.off(type, wrapped)
      }
    }
    dispatchEvent(ev: any) {
      this.emit(ev.type, ev.data)
      return true
    }
    [Symbol.dispose]() {
      this.close()
    }
  }
  class MessageChannel {
    port1 = new MessagePort()
    port2 = new MessagePort()
    constructor() {
      this.port1._other = this.port2
      this.port2._other = this.port1
    }
  }
  function receiveMessageOnPort(port: MessagePort) {
    if (!(port instanceof MessagePort)) throw Object.assign(new TypeError('The "port" argument must be a MessagePort instance'), { code: 'ERR_INVALID_ARG_TYPE' })
    return port._queue.length ? { message: port._queue.shift() } : undefined
  }
  class Worker extends EventEmitter {
    constructor() {
      super()
      unsupported('worker_threads', 'Worker')
    }
  }
  return {
    isMainThread: true,
    isInternalThread: false,
    parentPort: null,
    workerData: null,
    threadId: 0,
    resourceLimits: {},
    SHARE_ENV: Symbol.for('nodejs.worker_threads.SHARE_ENV'),
    Worker,
    MessageChannel,
    MessagePort,
    BroadcastChannel: g.BroadcastChannel,
    receiveMessageOnPort,
    markAsUntransferable: (o: object) => void untransferable.add(o),
    isMarkedAsUntransferable: (o: object) => untransferable.has(o),
    markAsUncloneable() {},
    moveMessagePortToContext: (port: unknown) => port,
    getEnvironmentData: (key: unknown) => env.get(key),
    setEnvironmentData: (key: unknown, value: unknown) => void (value === undefined ? env.delete(key) : env.set(key, value)),
    postMessageToThread: () => unsupported('worker_threads', 'postMessageToThread'),
  }
}

registerBuiltin('worker_threads', create)
