// The process event loop. Guest JS runs on the worker's own (browser) event
// loop; this file gives it Node's shape:
//
//   one turn = due timers → kernel events (fds, children, signals, watches)
//              → immediates → deferred completions
//
// A turn is started by any of three browser tasks: the single host timer that
// tracks the earliest Timeout, the `Atomics.waitAsync` on the process event
// word, or a MessageChannel ping (immediates, short timers, exit check).
// Because every turn runs due timers before it looks at kernel events, a timer
// that came due while the previous turn was running always fires before a
// file-watch event is delivered (chokidar's atomic-write and throttle timers
// depend on that order; the old runtime lost events when it was reversed).
//
// The process stays alive while `refs > 0`: ref'd timers, immediates, deferred
// completions and whatever called `loop.ref()` (open servers, children, a
// flowing stdin). When a turn ends with nothing left, the next turn emits
// `beforeExit` and, if still nothing, exits.
//
// The current async context (AsyncLocalStorage) is one module variable; every
// callback scheduled here captures it when scheduled and restores it when run.
import type { Kernel } from '../kernel/kernel'
import { TOKEN_CHILD, TOKEN_SIGNAL, TOKEN_WATCH } from '../kernel/kernel'
import type { Loop } from './runtime'

/** Async context frame: an immutable Map(AsyncLocalStorage -> store), or undefined. */
export type Frame = Map<object, unknown> | undefined
export const ctx: { frame: Frame; active: boolean } = { frame: undefined, active: false }

export interface LoopHooks {
  /** A guest callback threw. */
  uncaught(error: unknown): void
  /** Nothing keeps the process alive. Return true if a `beforeExit` listener scheduled more work. */
  beforeExit(): void
  /** Still nothing after beforeExit. */
  drained(): void
  signal(sig: number): void
}

interface Tick {
  fn: (...a: any[]) => void
  args: unknown[] | undefined
  frame: Frame
}

const kRefed = Symbol('refed')
const TIMEOUT_MAX = 2 ** 31 - 1

export interface LoopInternals extends Loop {
  Timeout: any
  Immediate: any
  setInterval(fn: (...a: any[]) => void, ms?: number, ...args: unknown[]): any
  clearTimeout(t: any): void
  clearImmediate(i: any): void
  queueMicrotask(fn: () => void): void
  drainTicks(): void
  start(kernel: Kernel, hooks: LoopHooks): void
  /** Stop delivering anything (process is exiting). */
  stop(): void
  refs(): number
  /** Run one turn now (used by blocking waits that want pending timers serviced). */
  turn(): void
}

export function createLoop(host: {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(t: any): void
  queueMicrotask(fn: () => void): void
  MessageChannel: { new (): MessageChannel }
}): LoopInternals {
  let kernel: Kernel | undefined
  let hooks: LoopHooks | undefined
  let refs = 0
  let stopped = false
  const stats: Record<string, number> = { turns: 0, timers: 0, immediates: 0, ticks: 0, events: 0, wakeTimer: 0, wakeKernel: 0, wakePing: 0 }
  const now = () => performance.now()

  // ---- nextTick ----
  let ticks: Tick[] = []
  let tickScheduled = false
  let draining = false
  function drainTicks() {
    if (draining) return
    draining = true
    try {
      while (ticks.length) {
        const batch = ticks
        ticks = []
        for (let i = 0; i < batch.length; i++) {
          const t = batch[i]
          const prev = ctx.frame
          ctx.frame = t.frame
          try {
            if (t.args === undefined) t.fn()
            else t.fn(...t.args)
          } catch (e) {
            hooks?.uncaught(e)
          } finally {
            ctx.frame = prev
          }
          stats.ticks++
        }
      }
    } finally {
      draining = false
      tickScheduled = false
    }
  }
  function nextTick(fn: (...a: any[]) => void, ...args: unknown[]) {
    if (typeof fn !== 'function') throw typeError('ERR_INVALID_ARG_TYPE', 'The "callback" argument must be of type function')
    ticks.push({ fn, args: args.length ? args : undefined, frame: ctx.frame })
    if (!tickScheduled) {
      tickScheduled = true
      host.queueMicrotask(drainTicks)
    }
  }
  function queueMicrotaskBound(fn: () => void) {
    if (typeof fn !== 'function') throw typeError('ERR_INVALID_ARG_TYPE', 'The "callback" argument must be of type function')
    const frame = ctx.frame
    host.queueMicrotask(() => {
      const prev = ctx.frame
      ctx.frame = frame
      try {
        fn()
      } catch (e) {
        hooks?.uncaught(e)
      } finally {
        ctx.frame = prev
      }
    })
  }

  /**
   * Call into guest code from a turn. While AsyncLocalStorage is in use the
   * callback's frame stays current after it returns: the microtasks it queued
   * (the continuations of native `await`, which no hook can see) run before
   * the next callback and so inherit it. `turn` runs one callback per browser
   * task in that mode, which is also Node's rule that the microtask queue is
   * drained after every callback.
   */
  function run(fn: (...a: any[]) => any, frame: Frame, thisArg: unknown, args: unknown[] | undefined) {
    const prev = ctx.frame
    ctx.frame = frame
    try {
      if (args === undefined) fn.call(thisArg)
      else fn.apply(thisArg, args)
    } catch (e) {
      hooks?.uncaught(e)
    } finally {
      if (!ctx.active) ctx.frame = prev
    }
    if (ticks.length) drainTicks()
    if (ctx.active) ctx.frame = frame
    ran++
  }
  let ran = 0
  function call(fn: (...a: any[]) => any, thisArg?: unknown, ...args: unknown[]) {
    if (stopped) return
    run(fn, ctx.frame, thisArg, args.length ? args : undefined)
  }
  function bind<F extends (...a: any[]) => any>(fn: F): F {
    const frame = ctx.frame
    if (frame === undefined && !ctx.active) return fn
    return function (this: unknown, ...args: unknown[]) {
      const prev = ctx.frame
      ctx.frame = frame
      try {
        return fn.apply(this, args)
      } finally {
        ctx.frame = prev
      }
    } as F
  }

  // ---- timers: a binary heap by due time, one host timer for the earliest ----
  let timerSeq = 0
  const heap: any[] = []
  const less = (a: any, b: any) => a._due < b._due || (a._due === b._due && a._seq < b._seq)
  function heapPush(t: any) {
    let i = heap.length
    heap.push(t)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!less(t, heap[p])) break
      heap[i] = heap[p]
      i = p
    }
    heap[i] = t
  }
  function heapPop(): any {
    const top = heap[0]
    const last = heap.pop()
    const n = heap.length
    if (n > 0) {
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && less(heap[c + 1], heap[c])) c++
        if (!less(heap[c], last)) break
        heap[i] = heap[c]
        i = c
      }
      heap[i] = last
    }
    return top
  }

  let nextTimerId = 1
  class Timeout {
    _idleTimeout: number
    _onTimeout: ((...a: any[]) => void) | null
    _timerArgs: unknown[] | undefined
    _repeat: number | null
    _destroyed = false
    _due = 0
    _seq = 0
    _queued = false
    _frame: Frame;
    [kRefed] = true
    _id = nextTimerId++
    constructor(fn: (...a: any[]) => void, ms: number, args: unknown[] | undefined, repeat: boolean) {
      ms = +ms
      if (!(ms >= 1 && ms <= TIMEOUT_MAX)) ms = 1
      this._idleTimeout = ms
      this._onTimeout = fn
      this._timerArgs = args
      this._repeat = repeat ? ms : null
      this._frame = ctx.frame
      refs++
      arm(this)
    }
    ref() {
      if (!this[kRefed]) {
        this[kRefed] = true
        if (!this._destroyed) refs++
      }
      return this
    }
    unref() {
      if (this[kRefed]) {
        this[kRefed] = false
        if (!this._destroyed) refs--
      }
      return this
    }
    hasRef() {
      return this[kRefed]
    }
    refresh() {
      if (!this._destroyed) arm(this)
      return this
    }
    close() {
      clearTimeout(this)
      return this
    }
    [Symbol.toPrimitive]() {
      timersById.set(this._id, this)
      return this._id
    }
    [Symbol.dispose]() {
      clearTimeout(this)
    }
  }
  const timersById = new Map<number, Timeout>()
  function arm(t: any) {
    t._due = now() + t._idleTimeout
    t._seq = ++timerSeq
    // A re-armed timer may still sit in the heap under its old due time; the
    // stale entry is recognised by `_seq` when it surfaces.
    heapPush({ _due: t._due, _seq: t._seq, t })
    scheduleWake()
  }
  function clearTimeout(t: any) {
    if (typeof t === 'number' || typeof t === 'string') t = timersById.get(+t)
    if (!t || !(t instanceof Timeout) || t._destroyed) return
    t._destroyed = true
    t._onTimeout = null
    timersById.delete(t._id)
    if (t[kRefed]) refs--
  }
  function setTimeout(fn: (...a: any[]) => void, ms?: number, ...args: unknown[]) {
    if (typeof fn !== 'function') throw typeError('ERR_INVALID_ARG_TYPE', 'The "callback" argument must be of type function')
    return new Timeout(fn, ms as number, args.length ? args : undefined, false)
  }
  function setInterval(fn: (...a: any[]) => void, ms?: number, ...args: unknown[]) {
    if (typeof fn !== 'function') throw typeError('ERR_INVALID_ARG_TYPE', 'The "callback" argument must be of type function')
    return new Timeout(fn, ms as number, args.length ? args : undefined, true)
  }
  /** Timers armed by a callback of this turn run in a later turn even if already due. */
  let timerLimit = 0
  /** Run the next due timer. False when none is due. */
  function stepTimer(): boolean {
    const t0 = now()
    while (heap.length && heap[0]._due <= t0 && heap[0]._seq <= timerLimit) {
      const e = heapPop()
      const t = e.t
      if (t._destroyed || t._seq !== e._seq) continue
      const fn = t._onTimeout
      if (t._repeat !== null) {
        t._idleTimeout = t._repeat
        t._due = t0 + t._repeat
        t._seq = ++timerSeq
        heapPush({ _due: t._due, _seq: t._seq, t })
      } else {
        t._destroyed = true
        timersById.delete(t._id)
        if (t[kRefed]) refs--
      }
      stats.timers++
      run(fn, t._frame, t, t._timerArgs)
      return true
    }
    return false
  }

  // ---- immediates and deferred completions ----
  class Immediate {
    _onImmediate: ((...a: any[]) => void) | null
    _args: unknown[] | undefined
    _frame: Frame;
    [kRefed] = true
    _destroyed = false
    constructor(fn: (...a: any[]) => void, args: unknown[] | undefined) {
      this._onImmediate = fn
      this._args = args
      this._frame = ctx.frame
    }
    ref() {
      if (!this[kRefed]) {
        this[kRefed] = true
        if (!this._destroyed) refs++
      }
      return this
    }
    unref() {
      if (this[kRefed]) {
        this[kRefed] = false
        if (!this._destroyed) refs--
      }
      return this
    }
    hasRef() {
      return this[kRefed]
    }
    [Symbol.dispose]() {
      clearImmediate(this)
    }
  }
  let immediates: Immediate[] = []
  function setImmediate(fn: (...a: any[]) => void, ...args: unknown[]) {
    if (typeof fn !== 'function') throw typeError('ERR_INVALID_ARG_TYPE', 'The "callback" argument must be of type function')
    const im = new Immediate(fn, args.length ? args : undefined)
    immediates.push(im)
    refs++
    ping()
    return im
  }
  function clearImmediate(im: any) {
    if (!im || !(im instanceof Immediate) || im._destroyed) return
    im._destroyed = true
    im._onImmediate = null
    if (im[kRefed]) refs--
  }
  function defer(fn: () => void) {
    setImmediate(fn)
  }
  let immediateBatch: Immediate[] = []
  let immediateAt = 0
  function stepImmediate(): boolean {
    while (immediateAt < immediateBatch.length) {
      const im = immediateBatch[immediateAt++]
      if (im._destroyed) continue
      im._destroyed = true
      if (im[kRefed]) refs--
      stats.immediates++
      run(im._onImmediate!, im._frame, im, im._args)
      return true
    }
    return false
  }

  // ---- kernel readiness ----
  // Handlers carry the async context that was current when they were registered.
  const fdHandlers = new Map<number, [(mask: number) => void, Frame]>()
  const childHandlers = new Map<number, [(status: number) => void, Frame]>()
  const watchHandlers = new Map<number, [(kind: number, path: string) => void, Frame]>()
  /** Children that exited before anyone asked. */
  const exited = new Map<number, number>()
  let waiting = false
  /** Kernel events taken but not yet delivered: [handler, args]. */
  let ready: [(...a: any[]) => void, unknown[], Frame][] = []
  let readyAt = 0
  /** Move queued kernel events into `ready`. */
  function takeKernel() {
    const k = kernel
    if (!k) return
    for (;;) {
      const events = k.takeEvents()
      if (events.length === 0) return
      for (let i = 0; i < events.length; i++) {
        const token = events[i][0]
        const mask = events[i][1]
        stats.events++
        if (token === TOKEN_WATCH) {
          for (const e of k.watchRead()) {
            const h = watchHandlers.get(e.id)
            if (h) ready.push([h[0], [e.kind, e.path], h[1]])
          }
        } else if (token === TOKEN_SIGNAL) {
          const bits = k.sigTake()
          for (let s = 1; s < 32; s++) if (bits & (1 << s)) ready.push([(sig: number) => hooks?.signal(sig), [s], undefined])
        } else if (token >= TOKEN_CHILD) {
          const pid = token - TOKEN_CHILD
          const h = childHandlers.get(pid)
          if (h) {
            childHandlers.delete(pid)
            ready.push([h[0], [mask], h[1]])
          } else exited.set(pid, mask)
        } else {
          // Looked up when delivered: the handler may be replaced or removed by an earlier callback.
          ready.push([(m: number) => fdHandlers.get(token)?.[0](m), [mask], fdHandlers.get(token)?.[1]])
        }
      }
    }
  }
  function stepKernel(): boolean {
    if (readyAt < ready.length) {
      const [h, args, frame] = ready[readyAt++]
      if (readyAt === ready.length) {
        ready = []
        readyAt = 0
      }
      run(h, frame, undefined, args)
      return true
    }
    return false
  }
  function armKernelWait() {
    const k = kernel
    if (!k || waiting || stopped) return
    const i32 = k.inst.i32()
    const word = k.x.bat_event_word() >>> 2
    const seen = Atomics.load(i32, word)
    // Anything queued between the last take and this load would be missed by the wait.
    takeKernel()
    if (ready.length) {
      ping()
      return
    }
    const r = (Atomics as any).waitAsync(i32, word, seen)
    if (!r.async) {
      ping()
      return
    }
    waiting = true
    r.value.then(() => {
      waiting = false
      stats.wakeKernel++
      turn()
    })
  }

  // ---- wake-ups ----
  const channel = new host.MessageChannel()
  let pinged = false
  channel.port1.onmessage = () => {
    pinged = false
    stats.wakePing++
    turn()
  }
  function ping() {
    if (!pinged && !stopped) {
      pinged = true
      channel.port2.postMessage(0)
    }
  }
  let hostTimer: unknown
  let hostTimerDue = Infinity
  function scheduleWake() {
    // Drop stale heap heads so they do not keep waking us.
    while (heap.length && (heap[0].t._destroyed || heap[0].t._seq !== heap[0]._seq)) heapPop()
    if (heap.length === 0 || stopped) return
    const due = heap[0]._due
    const delay = due - now()
    if (delay < 4) {
      // The browser clamps nested timers to 4 ms; short waits poll through the channel instead.
      ping()
      return
    }
    if (hostTimer !== undefined && hostTimerDue <= due) return
    if (hostTimer !== undefined) host.clearTimeout(hostTimer)
    hostTimerDue = due
    hostTimer = host.setTimeout(() => {
      hostTimer = undefined
      hostTimerDue = Infinity
      stats.wakeTimer++
      turn()
    }, delay)
  }

  let exitCheck = 0
  let ranAtTurnStart = 0
  let inTurn = false
  /** 0 idle, 1 timers, 2 kernel events, 3 immediates. A turn that yields between callbacks resumes in its phase. */
  let phase = 0
  function turn() {
    if (stopped || inTurn) return
    inTurn = true
    try {
      if (phase === 0) {
        stats.turns++
        timerLimit = timerSeq
        phase = 1
        ranAtTurnStart = ran
      }
      for (;;) {
        let did: boolean
        if (phase === 1) {
          did = stepTimer()
          if (!did) {
            phase = 2
            takeKernel()
            continue
          }
        } else if (phase === 2) {
          did = stepKernel()
          if (!did) {
            phase = 3
            immediateBatch = immediates
            immediates = []
            immediateAt = 0
            continue
          }
        } else {
          did = stepImmediate()
          if (!did) {
            phase = 0
            immediateBatch = []
            break
          }
        }
        if (stopped) return
        if (ctx.active) {
          // One callback per task: its microtasks (and their async context) finish before the next.
          ping()
          return
        }
      }
    } finally {
      inTurn = false
    }
    if (immediates.length) ping()
    scheduleWake()
    armKernelWait()
    // A turn that ran something starts the countdown again: its callbacks may have queued microtasks.
    if (ran !== ranAtTurnStart) exitCheck = 0
    if (refs <= 0 && ticks.length === 0 && ready.length === 0) {
      // Let the microtasks this turn produced run, then look again.
      if (exitCheck === 0) {
        exitCheck = 1
        ping()
      } else if (exitCheck === 1) {
        exitCheck = 2
        hooks?.beforeExit()
        if (ticks.length) drainTicks()
        ping()
      } else {
        exitCheck = 0
        hooks?.drained()
      }
    } else exitCheck = 0
  }

  return {
    stats,
    Timeout,
    Immediate,
    ref() {
      refs++
    },
    unref() {
      refs--
    },
    refs: () => refs,
    defer,
    onFd(fd, mask, cb) {
      fdHandlers.set(fd, [cb, ctx.frame])
      kernel!.subscribe(fd, mask)
      // An fd that is already ready queues its event at once: make sure a turn looks.
      ping()
    },
    offFd(fd) {
      if (fdHandlers.delete(fd)) {
        try {
          kernel!.subscribe(fd, 0)
        } catch {
          // already closed
        }
      }
    },
    onChild(pid, cb) {
      const status = exited.get(pid)
      if (status !== undefined) {
        exited.delete(pid)
        nextTick(cb, status)
      } else childHandlers.set(pid, [cb, ctx.frame])
    },
    onWatch(id, cb) {
      watchHandlers.set(id, [cb, ctx.frame])
    },
    offWatch(id) {
      watchHandlers.delete(id)
    },
    call,
    bind,
    nextTick,
    setImmediate,
    setTimeout,
    setInterval,
    clearTimeout,
    clearImmediate,
    queueMicrotask: queueMicrotaskBound,
    drainTicks,
    turn,
    start(k, h) {
      kernel = k
      hooks = h
      ping()
    },
    stop() {
      stopped = true
      if (hostTimer !== undefined) host.clearTimeout(hostTimer)
      // Do not leave an async waiter registered on shared memory when this worker is terminated.
      if (kernel && waiting) {
        try {
          Atomics.notify(kernel.inst.i32(), kernel.x.bat_event_word() >>> 2)
        } catch {
          // the process record may already be gone
        }
      }
    },
  }
}

function typeError(code: string, message: string): TypeError {
  const e = new TypeError(message) as TypeError & { code: string }
  e.code = code
  return e
}
