export interface MatchedReadinessBudgets { listenMs: number; connectMs: number; hydrationMs: number; overallMs: number }
export const prospectivePolicy = Object.freeze({listenMs:60000,connectMs:45000,hydrationMs:60000,overallMs:90000,observationMs:180000,verifierReadMs:30000,watchdogMs:300000,cleanupMs:10000});
const pending = new Set<Promise<unknown>>();
export async function joinPendingReadiness(): Promise<void> { await Promise.allSettled([...pending]); }
/** Phase9-compatible defaults; overrides must be frozen identically before a new pair. */
export function matchedReadinessBudgets(parameters: URLSearchParams): MatchedReadinessBudgets {
  const defaults = { listenMs: 30000, connectMs: 60000, hydrationMs: 90000, overallMs: 120000 };
  const budgets = { ...defaults };
  for (const name of Object.keys(defaults) as (keyof MatchedReadinessBudgets)[]) {
    const supplied = parameters.get('readiness.' + name);
    const value = supplied === null ? defaults[name] : Number(supplied);
    if (!Number.isSafeInteger(value) || value <= 0 || value > 240000) throw Error(`Invalid matched readiness ${name}`);
    budgets[name] = value;
  }
  return Object.freeze(budgets);
}

export async function boundedReadiness<T>(milliseconds: number, signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>, cleanupMs = 10000): Promise<T> {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(Error(`Matched readiness budget exhausted (${milliseconds}ms)`)), milliseconds);
  let aborted!: () => void;
  let owned: Promise<T> | undefined;
  try {
    combined.throwIfAborted();
    owned = Promise.resolve().then(() => task(combined));
    pending.add(owned);
    void owned.finally(() => pending.delete(owned!)).catch(() => {});
    return await Promise.race([owned, new Promise<never>((_, reject) => {
      aborted = () => reject(combined.reason);
      combined.addEventListener('abort', aborted, { once: true });
    })]);
  } catch (error) {
    controller.abort(error);
    // Cleanup has a separate receipt/deadline. Expiration is NOT settlement and
    // callers must retain ownership and forbid teardown/replacement in that case.
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (owned) await Promise.race([owned.catch(() => {}), new Promise<never>((_, reject) => {
        cleanupTimer = setTimeout(() => reject(new AggregateError([error], 'Readiness cleanup unresolved; quiescence unproven')), cleanupMs);
      })]);
    } finally { clearTimeout(cleanupTimer); }
    throw error;
  } finally { clearTimeout(timer); combined.removeEventListener('abort', aborted); controller.abort(Error('Matched readiness ended')); }
}

/** First failure cancels siblings, but rejection is not returned until all join. */
export async function joinedReadiness(signal: AbortSignal, tasks: ((signal: AbortSignal) => Promise<void>)[]): Promise<void> {
  const cancellation = new AbortController();
  const combined = AbortSignal.any([signal, cancellation.signal]);
  let failure: unknown;
  const results = await Promise.allSettled(tasks.map(task => Promise.resolve().then(() => {
    combined.throwIfAborted(); return task(combined);
  }).catch(error => { if (!cancellation.signal.aborted) { failure = error; cancellation.abort(error); } throw error; })));
  combined.throwIfAborted();
  if (results.some(result => result.status === 'rejected')) throw failure;
}
