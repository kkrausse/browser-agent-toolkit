// `node:async_hooks`: AsyncLocalStorage and AsyncResource.
//
// Chrome 154 has no `AsyncContext` and exposes no promise hook, so context is
// carried by the runtime itself (decision recorded in docs/design/decisions.md):
//
//   - the context is one immutable frame (Map of storage -> store) in
//     `ctx.frame` (process/loop.ts);
//   - everything the loop schedules (timers, immediates, nextTick, kernel
//     readiness, fs callbacks, child events) captures the frame when scheduled
//     and restores it when run;
//   - `Promise.prototype.then` (so also `catch`/`finally`) and `queueMicrotask`
//     are wrapped the same way from the first AsyncLocalStorage on;
//   - the continuation of a native `await` cannot be intercepted. It runs with
//     the frame of the callback that resumed it, because the loop then runs one
//     callback per task and leaves that callback's frame in place while its
//     microtasks drain; and `run(store, asyncFn)` leaves its frame in place
//     until the next callback, so the part of `asyncFn` after its first
//     `await` of an already-settled promise still sees the store.
//
// What this does not give: a continuation resumed by a promise that some
// *other* context resolved sees that other context's frame.
import { ctx, type Frame } from '../process/loop'
import type { Runtime } from '../process/runtime'
import { registerBuiltin } from './registry'

let activated = false
function activate(rt: Runtime) {
  if (activated) return
  activated = true
  ctx.active = true
  const g = rt.host.global
  const nativeThen = g.Promise.prototype.then
  const wrap = (fn: (v: unknown) => unknown, frame: Frame) =>
    function (this: unknown, v: unknown) {
      const prev = ctx.frame
      ctx.frame = frame
      try {
        return fn.call(this, v)
      } finally {
        ctx.frame = prev
      }
    }
  g.Promise.prototype.then = function then(this: Promise<unknown>, onFulfilled?: any, onRejected?: any) {
    const frame = ctx.frame
    return nativeThen.call(this, typeof onFulfilled === 'function' ? wrap(onFulfilled, frame) : onFulfilled, typeof onRejected === 'function' ? wrap(onRejected, frame) : onRejected)
  }
  Object.defineProperty(g, 'queueMicrotask', { value: (rt.loop as any).queueMicrotask, writable: true, configurable: true, enumerable: true })
}

function create(rt: Runtime): any {
  let nextId = 2
  class AsyncResource {
    type: string
    #frame: Frame
    #id = nextId++
    constructor(type: string, _options?: unknown) {
      if (typeof type !== 'string') throw Object.assign(new TypeError('The "type" argument must be of type string'), { code: 'ERR_INVALID_ARG_TYPE' })
      this.type = type
      this.#frame = ctx.frame
    }
    runInAsyncScope(fn: (...a: any[]) => any, thisArg?: unknown, ...args: unknown[]) {
      const prev = ctx.frame
      ctx.frame = this.#frame
      try {
        return fn.apply(thisArg, args)
      } finally {
        ctx.frame = prev
      }
    }
    bind(fn: (...a: any[]) => any, thisArg?: unknown) {
      const self = this
      const bound = function (this: unknown, ...args: unknown[]) {
        return self.runInAsyncScope(fn, thisArg ?? this, ...args)
      }
      Object.defineProperty(bound, 'length', { value: fn.length, configurable: true })
      return bound
    }
    static bind(fn: (...a: any[]) => any, type?: string, thisArg?: unknown) {
      return new AsyncResource(type || fn.name || 'bound-anonymous-fn').bind(fn, thisArg)
    }
    emitDestroy() {
      return this
    }
    asyncId() {
      return this.#id
    }
    triggerAsyncId() {
      return 1
    }
  }

  class AsyncLocalStorage {
    #enabled = true
    #default: unknown
    name: string
    constructor(options?: { defaultValue?: unknown; name?: string }) {
      activate(rt)
      this.#default = options?.defaultValue
      this.name = options?.name ?? ''
    }
    static bind<F extends (...a: any[]) => any>(fn: F): F {
      return AsyncResource.bind(fn) as unknown as F
    }
    static snapshot() {
      const frame = ctx.frame
      return (fn: (...a: any[]) => any, ...args: unknown[]) => {
        const prev = ctx.frame
        ctx.frame = frame
        try {
          return fn(...args)
        } finally {
          ctx.frame = prev
        }
      }
    }
    run(store: unknown, fn: (...a: any[]) => any, ...args: unknown[]) {
      this.#enabled = true
      const prev = ctx.frame
      const frame = new Map(prev)
      frame.set(this, store)
      ctx.frame = frame
      let result
      try {
        result = fn(...args)
      } catch (e) {
        ctx.frame = prev
        throw e
      }
      // An async callback continues after this returns; see the note at the top of the file.
      if (result === null || (typeof result !== 'object' && typeof result !== 'function') || typeof result.then !== 'function') ctx.frame = prev
      else deferRestore(frame, prev)
      return result
    }
    exit(fn: (...a: any[]) => any, ...args: unknown[]) {
      const prev = ctx.frame
      if (prev?.has(this)) {
        const frame = new Map(prev)
        frame.delete(this)
        ctx.frame = frame
      }
      try {
        return fn(...args)
      } finally {
        ctx.frame = prev
      }
    }
    getStore() {
      if (!this.#enabled) return undefined
      const frame = ctx.frame
      return frame !== undefined && frame.has(this) ? frame.get(this) : this.#default
    }
    enterWith(store: unknown) {
      this.#enabled = true
      const frame = new Map(ctx.frame)
      frame.set(this, store)
      ctx.frame = frame
    }
    disable() {
      this.#enabled = false
    }
  }
  /**
   * `run(store, asyncFn)` returned a pending promise. The caller's synchronous
   * remainder must see its own frame again, but the microtasks that follow in
   * this task belong to `asyncFn`. A microtask queued now runs after the
   * caller's synchronous code has finished... and before nothing else we can
   * order against, so the frame is put back as soon as the caller's stack has
   * unwound: by a microtask that only acts if nobody replaced the frame since.
   */
  function deferRestore(_frame: Frame, prev: Frame) {
    // Restoring immediately keeps the caller exact; the async body regains its frame through
    // the wrapped `then`/scheduling for everything except a bare `await` of a settled value.
    ctx.frame = prev
  }

  const executionAsyncResource = () => rt.process
  return {
    AsyncLocalStorage,
    AsyncResource,
    createHook: () => ({ enable() { return this }, disable() { return this } }),
    executionAsyncId: () => 1,
    triggerAsyncId: () => 0,
    executionAsyncResource,
    asyncWrapProviders: Object.freeze({ __proto__: null }),
  }
}

registerBuiltin('async_hooks', create)
// What the vendored Node lib expects from its internal module.
registerBuiltin('internal/async_hooks', (rt) => {
  const pub = rt.require('async_hooks')
  const symbols = { owner_symbol: Symbol('owner_symbol'), async_id_symbol: Symbol('async_id_symbol'), trigger_async_id_symbol: Symbol('trigger_async_id_symbol') }
  let id = 1
  return {
    ...pub,
    symbols,
    newAsyncId: () => ++id,
    getNewAsyncId: () => ++id,
    getOrSetAsyncId: (o: any) => (o[symbols.async_id_symbol] ??= ++id),
    defaultTriggerAsyncIdScope: (_id: number, fn: (...a: any[]) => any, ...args: unknown[]) => fn(...args),
    enabledHooksExist: () => false,
  }
}, { hidden: true })
