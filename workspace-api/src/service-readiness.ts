/** Fixed prospective budgets, never reset by progress or retries. */
export interface ServiceReadiness {
  listenMs?: number;
  connectMs?: number;
  overallMs?: number;
  signal?: AbortSignal;
}

export function readinessBudget(options: ServiceReadiness = {}, lifetime?: AbortSignal) {
  const values = { listenMs: options.listenMs ?? 30000, connectMs: options.connectMs ?? 60000, overallMs: options.overallMs ?? 120000 };
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 240000) throw Error(`Service readiness ${name} must be 1–240000ms`);
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...[lifetime, options.signal].filter((s): s is AbortSignal => !!s)]);
  const timer = setTimeout(() => controller.abort(new Error(`Service readiness overall budget exhausted (${values.overallMs}ms)`)), values.overallMs);
  const wait = async <T>(task: () => Promise<T>): Promise<T> => {
    let aborted!: () => void;
    try {
      signal.throwIfAborted();
      return await Promise.race([Promise.resolve().then(task), new Promise<never>((_, reject) => {
        aborted = () => reject(signal.reason);
        signal.addEventListener('abort', aborted, { once: true });
      })]);
    } finally { signal.removeEventListener('abort', aborted); }
  };
  const stage = async <T>(name: 'listen' | 'connect', task: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const stageController = new AbortController();
    const stageSignal = AbortSignal.any([signal, stageController.signal]);
    const milliseconds = name === 'listen' ? values.listenMs : values.connectMs;
    const timeout = setTimeout(() => stageController.abort(new Error(`Service readiness ${name} budget exhausted (${milliseconds}ms)`)), milliseconds);
    let aborted!: () => void;
    try {
      stageSignal.throwIfAborted();
      return await Promise.race([Promise.resolve().then(() => task(stageSignal)), new Promise<never>((_, reject) => {
        aborted = () => reject(stageSignal.reason);
        stageSignal.addEventListener('abort', aborted, { once: true });
      })]);
    } finally {
      clearTimeout(timeout);
      stageSignal.removeEventListener('abort', aborted);
      stageController.abort(new Error('Readiness stage ended'));
    }
  };
  return { ...values, signal, wait, stage, dispose() { clearTimeout(timer); controller.abort(new Error('Readiness ended')); } };
}
