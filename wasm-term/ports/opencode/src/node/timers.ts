// Node-style timer handles for a Worker: setTimeout/setInterval return an
// object with ref()/unref()/refresh() (code written for Node calls them),
// which still converts to the numeric id for clearTimeout and friends.
export function installNodeTimers(scope: Record<string, any> = globalThis): void {
  if (scope.__wasmTermTimers) return
  scope.__wasmTermTimers = true
  const wrap = (set: (...args: any[]) => number, clear: (id: number) => void) =>
    (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      let id = set(callback, delay, ...args)
      const handle = {
        ref: () => handle,
        unref: () => handle,
        hasRef: () => true,
        refresh() {
          clear(id)
          id = set(callback, delay, ...args)
          return handle
        },
        close() {
          clear(id)
          return handle
        },
        [Symbol.toPrimitive]: () => id,
      }
      return handle
    }
  const clearer = (clear: (id: number) => void) => (handle: unknown) =>
    clear(handle == null ? (handle as never) : Number(handle))
  const { setTimeout, setInterval, clearTimeout, clearInterval } = scope
  scope.setTimeout = wrap(setTimeout.bind(scope), clearTimeout.bind(scope))
  scope.setInterval = wrap(setInterval.bind(scope), clearInterval.bind(scope))
  scope.clearTimeout = clearer(clearTimeout.bind(scope))
  scope.clearInterval = clearer(clearInterval.bind(scope))
  scope.setImmediate ??= (callback: (...args: unknown[]) => void, ...args: unknown[]) => scope.setTimeout(callback, 0, ...args)
  scope.clearImmediate ??= scope.clearTimeout
}
