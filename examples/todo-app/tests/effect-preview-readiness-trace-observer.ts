// QA-only synchronous observation. No requests, timers, promise observers, reads,
// retries, body clones, protocol replacements, or exception normalization.
(() => {
  const root = globalThis as any;
  if (root.effectPreviewReadinessTrace) throw Error('Trace already installed');
  const receipt = { version: 'effect-preview-readiness-trace-1', armed: false, events: [] as any[], dropped: 0, bytes: 0, observerErrors: 0, limit: { events: 2048, bytes: 1024 * 1024 } };
  const error = (value: any, depth = 0): any => {
    try {
      if (value === null || typeof value !== 'object') return { value: String(value) };
      const result: any = { name: value.name, message: value.message, stack: value.stack, code: value.code };
      if ('cause' in value) result.cause = depth < 3 ? error(value.cause, depth + 1) : { truncated: true };
      if (Array.isArray(value.errors)) result.errors = value.errors.slice(0, 8).map((e: any) => error(e, depth + 1));
      return result;
    } catch { receipt.observerErrors++; return { unavailable: true }; }
  };
  const record = (event: string, data: any = {}) => {
    if (!receipt.armed) return;
    try {
      const entry = { sequence: receipt.events.length + receipt.dropped + 1, wall: Date.now(), mono: performance.now(), event, data };
      const text = JSON.stringify(entry);
      if (receipt.events.length >= receipt.limit.events || receipt.bytes + text.length > receipt.limit.bytes) { receipt.dropped++; return; }
      receipt.bytes += text.length; receipt.events.push(entry);
    } catch { receipt.observerErrors++; }
  };
  const signal = (value: AbortSignal, label: string, budgetMs?: number) => {
    if (!receipt.armed) return value;
    try {
      record('signal.created-or-observed', { label, budgetMs, aborted: value.aborted, reason: value.aborted ? error(value.reason) : undefined });
      value.addEventListener('abort', () => record('signal.abort', { label, reason: error(value.reason) }), { once: true });
    } catch { receipt.observerErrors++; }
    return value;
  };
  const message = (direction: string, value: any) => {
    if (!receipt.armed) return;
    try {
      // Retain IDs only if actually supplied by the message. Never copy payloads.
      record('stream.' + direction, { op: value.op, id: value.id, type: value.type, status: value.status, statusText: value.statusText, headers: value.headers, bytes: value.bytes?.byteLength, error: value.error });
    } catch { receipt.observerErrors++; }
  };
  root.effectPreviewReadinessTrace = {
    receipt, record, error, signal, message,
    arm() { receipt.armed = true; record('readiness.arm', { budgetMs: 20000 }); },
    response(value: Response) {
      if (!receipt.armed) return;
      try { record('fetch.headers-returned', { status: value.status, statusText: value.statusText, ok: value.ok, type: value.type, url: value.url, headers: [...value.headers], bodyUsed: value.bodyUsed }); }
      catch { receipt.observerErrors++; }
    },
  };
})();
