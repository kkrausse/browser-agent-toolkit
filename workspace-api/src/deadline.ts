/** Wait for `work` at most `ms`. The deadline only stops the waiting: `work` is not
 * cancelled, so the caller must keep tracking whatever it still owns. An aborted
 * `signal` ends the wait at once by rejecting with its reason. */
export async function within<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  try {
    return await Promise.race([
      work.then(value => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve, reject) => {
        timer = setTimeout(() => resolve({ timedOut: true }), ms);
        abort = () => reject(signal!.reason);
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally { clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
}
/** One deadline shared by every stage of an operation. Each stage waits at most
 * `remaining()`, so stages draw down the same budget instead of adding their own. */
export interface Budget { readonly totalMs: number; readonly signal?: AbortSignal; remaining(): number }
export function budget(totalMs: number, signal?: AbortSignal): Budget {
  const end = performance.now() + totalMs;
  return { totalMs, signal, remaining: () => Math.max(0, end - performance.now()) };
}
export function timeoutMs(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer of milliseconds`);
  return value;
}
