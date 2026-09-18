export interface ControllerDiagnosticEvent {
  /** Stable across delivery retries. */
  id?: string;
  runId: string;
  time: string;
  event: string;
  data: unknown;
}
export interface ControllerDiagnosticOptions {
  /** Optional local sink. No network calls are made by the integration. */
  onDiagnostic?: (event: ControllerDiagnosticEvent) => void;
  /** Include bounded, redacted guest stdout/stderr as guest.output events. Default: false. */
  captureProcessOutput?: boolean | (() => boolean);
}
export function safeText(value: string): string {
  return value
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, "$1 [redacted]")
    .replace(/((?:authorization|password|token|secret|api[_-]?key|cookie)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@")
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/g, "$1?[redacted]").slice(0, 6000);
}
export function sanitizeDiagnostic(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[bounded]";
  if (value instanceof Error) return sanitizeDiagnostic({ name: value.name, message: value.message, stack: value.stack, cause: value.cause }, depth + 1);
  if (typeof value === "string") return safeText(value);
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeDiagnostic(item, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, item]) => [key, /authorization|cookie|password|token|secret|headers|body|prompt|source|contents|api[_-]?key/i.test(key) ? "[redacted]" : sanitizeDiagnostic(item, depth + 1)]));
  return safeText(String(value));
}
export function createControllerDiagnostics(options: ControllerDiagnosticOptions) {
  let runId = "idle";
  return {
    get runId() { return runId; },
    begin() { runId = crypto.randomUUID(); },
    record(event: string, data?: unknown) {
      if (!options.onDiagnostic) return;
      try { options.onDiagnostic(boundDiagnostic({ runId, time: new Date().toISOString(), event, data })); }
      catch { /* Observability must never break lifecycle or cleanup. */ }
    },
    flush() {},
  };
}

export function boundDiagnostic(event: ControllerDiagnosticEvent): ControllerDiagnosticEvent {
  let data: unknown;
  try {
    data = sanitizeDiagnostic(event.data);
    if (new TextEncoder().encode(JSON.stringify(data)).length > 16000) data = '[event exceeded 16KB]';
  } catch { data = '[unreadable diagnostic data]'; }
  return { ...event, id: event.id ?? crypto.randomUUID(), data };
}

export type DiagnosticScope = ReturnType<typeof createDiagnosticScope>;
/** Shared host/browser stage timings, including a heartbeat while work is pending. */
export function createDiagnosticScope(onDiagnostic?: (event: ControllerDiagnosticEvent) => void, runId: string = crypto.randomUUID(), heartbeatMs = 5000) {
  const record = (event: string, data?: unknown): void => {
    if (!onDiagnostic) return;
    try { onDiagnostic(boundDiagnostic({ runId, time: new Date().toISOString(), event, data })); } catch {}
  };
  return {
    runId, record, enabled: !!onDiagnostic,
    async stage<T>(name: string, task: () => Promise<T>, detail?: Record<string, unknown>): Promise<T> {
      const started = performance.now();
      const elapsed = () => ({ ...detail, elapsedMs: Math.round(performance.now() - started) });
      record(name + '.start', detail);
      const timer = onDiagnostic ? setInterval(() => record(name + '.waiting', elapsed()), heartbeatMs) : undefined;
      (timer as unknown as { unref?(): void })?.unref?.();
      try { const result = await task(); record(name + '.ready', elapsed()); return result; }
      catch (error) { record(name + '.failed', { ...elapsed(), error }); throw error; }
      finally { clearInterval(timer); }
    },
  };
}
