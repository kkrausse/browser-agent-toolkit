export interface MatchedReadinessBudgets { listenMs: number; connectMs: number; hydrationMs: number; overallMs: number }
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

export async function boundedReadiness<T>(milliseconds: number, signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(Error(`Matched readiness budget exhausted (${milliseconds}ms)`)), milliseconds);
  let aborted!: () => void;
  try {
    combined.throwIfAborted();
    return await Promise.race([Promise.resolve().then(() => task(combined)), new Promise<never>((_, reject) => {
      aborted = () => reject(combined.reason);
      combined.addEventListener('abort', aborted, { once: true });
    })]);
  } finally { clearTimeout(timer); combined.removeEventListener('abort', aborted); controller.abort(Error('Matched readiness ended')); }
}
