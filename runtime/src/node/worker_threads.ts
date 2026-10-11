// `node:worker_threads`. MessageChannel/MessagePort are implemented here, in
// the process's own event loop, rather than on the browser's: a Node port has
// `on('message')`, keeps the process alive while it listens, and can be read
// synchronously (`receiveMessageOnPort`), none of which a browser port does.
//
// `Worker`: a worker thread is a process of its own here (another browser
// Worker with its own Node globals and its own kernel pid), joined to its
// parent by `child_process.fork`'s channel. So messages are JSON: no
// transfer lists, no shared memory, no MessagePorts across, and values JSON
// cannot carry (Map, typed arrays, undefined members) do not arrive as sent.
// Enough for a worker that is asked things and answers (a parser, a
// formatter); `workerData` travels the same way.
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
  const proc = rt.process
  // The worker side: this process was started by `new Worker` below.
  let thread: { threadId: number; workerData: unknown } | undefined
  if (proc.env.BAT_WORKER_THREAD) {
    try {
      thread = JSON.parse(proc.env.BAT_WORKER_THREAD)
    } catch {
      // not ours
    }
    delete proc.env.BAT_WORKER_THREAD
  }
  let parentPort: any = null
  if (thread) {
    // Connects the channel (the child side of fork).
    rt.require('child_process')
    parentPort = new EventEmitter()
    parentPort.postMessage = (value: unknown) => void proc.send?.(value === undefined ? null : value)
    parentPort.close = () => proc.disconnect?.()
    parentPort.ref = parentPort.unref = () => parentPort
    parentPort.start = () => {}
    // As in Node, a worker lives while its parent port has a listener (or anything else is pending).
    const deliver = (message: unknown) => parentPort.emit('message', message)
    parentPort.on('newListener', (name: string) => {
      if (name === 'message' && parentPort.listenerCount('message') === 0) proc.on('message', deliver)
    })
    parentPort.on('removeListener', (name: string) => {
      if (name === 'message' && parentPort.listenerCount('message') === 0) proc.off('message', deliver)
    })
    // The parent is gone or called terminate().
    proc.on('disconnect', () => proc.exit())
  }

  let nextThread = 1
  class Worker extends EventEmitter {
    threadId: number
    _child: any
    _code: number | undefined
    constructor(filename: unknown, options: any = {}) {
      super()
      const fs = rt.require('fs')
      this.threadId = nextThread++
      let file = filename instanceof g.URL ? rt.require('url').fileURLToPath(filename) : String(filename)
      let scratch: string | undefined
      if (options.eval) {
        // Source text: the loader wants a file.
        scratch = file = `/tmp/.worker-${proc.pid}-${this.threadId}.${options.type === 'module' ? 'mjs' : 'cjs'}`
        fs.writeFileSync(file, String(filename))
      }
      const env = options.env && typeof options.env === 'object' ? options.env : proc.env
      // stdin is not the parent's: a terminal must not take the worker for its foreground process.
      this._child = rt.require('child_process').fork(file, options.argv ?? [], {
        env: { ...env, BAT_WORKER_THREAD: JSON.stringify({ threadId: this.threadId, workerData: options.workerData ?? null }) },
        execArgv: options.execArgv ?? [],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      })
      this._child.on('spawn', () => this.emit('online'))
      this._child.on('message', (message: unknown) => this.emit('message', message))
      this._child.on('error', (e: Error) => this.emit('error', e))
      this._child.on('exit', (code: number | null) => {
        this._code = code ?? 1
        if (scratch) fs.rmSync(scratch, { force: true })
        this.emit('exit', this._code)
      })
    }
    postMessage(value: unknown) {
      if (this._code === undefined && this._child.connected) this._child.send(value === undefined ? null : value)
    }
    terminate() {
      return new Promise<number>((resolve) => {
        if (this._code !== undefined) return resolve(this._code)
        this.once('exit', resolve)
        this._child.kill('SIGKILL')
      })
    }
    ref() {
      this._child.ref()
    }
    unref() {
      this._child.unref()
    }
  }
  return {
    isMainThread: !thread,
    isInternalThread: false,
    parentPort,
    workerData: thread?.workerData ?? null,
    threadId: thread?.threadId ?? 0,
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
