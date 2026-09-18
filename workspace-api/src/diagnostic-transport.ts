import { boundDiagnostic, type ControllerDiagnosticEvent } from './react-diagnostics.js';

export type DiagnosticBatch = { clientId: string; events: ControllerDiagnosticEvent[] };

/** Bounded, ordered, at-least-once delivery. Stable event IDs let the sink deduplicate retries. */
export function createDiagnosticReporter(options: {
  transport(batch: DiagnosticBatch): Promise<void>;
  enabled?: boolean;
  clientId?: string;
  flushIntervalMs?: number;
  retryIntervalMs?: number;
  maxRetries?: number;
  maxQueue?: number;
  onError?(error: unknown): void;
}) {
  const clientId = options.clientId ?? crypto.randomUUID();
  const queue: ControllerDiagnosticEvent[] = [];
  const maxQueue = Math.max(1, options.maxQueue ?? 500);
  let enabled = options.enabled ?? true, disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined, pending: Promise<void> | undefined;
  let failures = 0, dropped = 0;
  const schedule = (): void => {
    if (!enabled || disposed || timer || failures > (options.maxRetries ?? 3)) return;
    timer = setTimeout(() => void flush(), failures ? (options.retryIntervalMs ?? 1000) * 2 ** (failures - 1) : (options.flushIntervalMs ?? 200));
    (timer as unknown as { unref?(): void })?.unref?.();
  };
  const trim = (): void => { if (queue.length > maxQueue) dropped += queue.splice(0, queue.length - maxQueue).length; };
  const onDiagnostic = (event: ControllerDiagnosticEvent): void => {
    if (!enabled || disposed) return;
    queue.push(boundDiagnostic(event)); trim();
    // A new event resumes a paused reporter; each burst still has bounded retries.
    if (failures > (options.maxRetries ?? 3)) failures = 0;
    schedule();
  };
  const flush = (): Promise<void> => {
    clearTimeout(timer); timer = undefined;
    if (pending) return pending;
    if (!enabled || disposed || !queue.length) return Promise.resolve();
    pending = (async () => {
      while (enabled && !disposed && queue.length) {
        const events: ControllerDiagnosticEvent[] = [];
        let bytes = 256;
        if (dropped) {
          events.push(boundDiagnostic({ runId: clientId, time: new Date().toISOString(), event: 'diagnostics.dropped', data: { count: dropped } }));
          bytes += JSON.stringify(events[0]).length; dropped = 0;
        }
        while (queue.length && events.length < 50) {
          const next = queue[0]!;
          const size = new TextEncoder().encode(JSON.stringify(next)).length + 1;
          if (events.length && bytes + size > 48000) break;
          bytes += size; events.push(queue.shift()!);
        }
        try { await options.transport({ clientId, events }); failures = 0; }
        catch (error) {
          if (enabled && !disposed) { queue.unshift(...events); trim(); failures++; }
          try { options.onError?.(error); } catch {}
          break;
        }
      }
    })().finally(() => { pending = undefined; if (queue.length) schedule(); });
    return pending;
  };
  return {
    clientId, onDiagnostic, flush,
    get enabled() { return enabled && !disposed; },
    setEnabled(value: boolean): void {
      enabled = value;
      if (!value) { clearTimeout(timer); timer = undefined; queue.length = 0; dropped = 0; failures = 0; }
      else if (queue.length) schedule();
    },
    record(event: string, data?: unknown): void { onDiagnostic({ runId: clientId, time: new Date().toISOString(), event, data }); },
    async dispose(): Promise<void> { await flush(); disposed = true; clearTimeout(timer); queue.length = 0; },
  };
}
