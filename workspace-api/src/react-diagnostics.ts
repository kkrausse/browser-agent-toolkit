export interface ControllerDiagnosticEvent {
  runId: string;
  time: string;
  event: string;
  data: unknown;
}
export interface ControllerDiagnosticOptions {
  /** Optional local sink. No network calls are made by the integration. */
  onDiagnostic?: (event: ControllerDiagnosticEvent) => void;
}
export function safeText(value: string): string {
  return value.slice(0, 6000)
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, "$1 [redacted]")
    .replace(/((?:authorization|password|token|secret|api[_-]?key|cookie)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@")
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/g, "$1?[redacted]");
}
function safeData(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[bounded]";
  if (value instanceof Error) return safeData({ name: value.name, message: value.message, stack: value.stack, cause: value.cause }, depth + 1);
  if (typeof value === "string") return safeText(value);
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.slice(0, 10).map(item => safeData(item, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 10).map(([key, item]) => [key, /authorization|cookie|password|token|secret|headers|body|prompt|source|contents|api[_-]?key/i.test(key) ? "[redacted]" : safeData(item, depth + 1)]));
  return safeText(String(value));
}
export function createControllerDiagnostics(options: ControllerDiagnosticOptions) {
  let runId = "idle";
  return {
    begin() { runId = crypto.randomUUID(); },
    record(event: string, data?: unknown) {
      if (!options.onDiagnostic) return;
      const sanitized = safeData(data);
      const bounded = JSON.stringify(sanitized);
      try { options.onDiagnostic({ runId, time: new Date().toISOString(), event, data: bounded && bounded.length > 16000 ? "[event exceeded 16KB]" : sanitized }); }
      catch { /* Observability must never break lifecycle or cleanup. */ }
    },
    flush() {},
  };
}
