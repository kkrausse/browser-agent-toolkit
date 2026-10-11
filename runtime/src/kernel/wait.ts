// Sleeping on a word of the shared memory without blocking the thread, with a time limit.
//
// `Atomics.waitAsync(i32, index, value, timeout)` is not used: in WebKit (Playwright's
// Linux build 2370, WebKit 26) a worker waiting that way is often woken neither by
// `Atomics.notify` nor by the timeout until something else runs on its event loop
// (runtime/harness/webkit/probe-waitasync.ts: 31 of 40 notifies unanswered after 3 s;
// in the runtime, kerneld sat on a spawn request for 5 s). The form without a timeout
// wakes within 0.2 ms there, as in Chrome, so the limit is an ordinary timer raced
// against it.
const hostSetTimeout: (fn: () => void, ms: number) => unknown = globalThis.setTimeout.bind(globalThis)
const hostClearTimeout: (id: any) => void = globalThis.clearTimeout.bind(globalThis)

// The wait in flight per word. A wait that timed out is still registered with the engine;
// the next call for the same word and value joins it instead of adding another waiter.
const pending = new Map<number, { seen: number; woke: Promise<void> }>()

/**
 * Resolve when `i32[index]` is notified, at once if it no longer holds `seen`, or after
 * `timeoutMs`. Callers re-check their condition afterwards, as with any futex wait.
 */
export async function waitWord(i32: Int32Array, index: number, seen: number, timeoutMs: number): Promise<void> {
  let wait = pending.get(index)
  if (!wait || wait.seen !== seen) {
    const r = (Atomics as any).waitAsync(i32, index, seen)
    if (!r.async) return
    const mine = {
      seen,
      woke: (r.value as Promise<unknown>).then(() => {
        if (pending.get(index) === mine) pending.delete(index)
      }),
    }
    pending.set(index, mine)
    wait = mine
  }
  let timer: unknown
  await Promise.race([wait.woke, new Promise<void>((resolve) => (timer = hostSetTimeout(resolve, timeoutMs)))])
  hostClearTimeout(timer)
}
