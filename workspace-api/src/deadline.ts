/** Wait for `work` at most `ms`. The deadline only stops the waiting: `work` is not
 * cancelled, so the caller must keep tracking whatever it still owns. */
export async function within<T>(work: Promise<T>, ms: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(value => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}
export function timeoutMs(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer of milliseconds`);
  return value;
}
