// QA only. Installed before importing the editor/runtime. No application mutations.
type Row = { seq: number; utc: string; ms: number; kind: string; data: unknown };
const rows: Row[] = [];
const cap = 4096;
let seq = 0, dropped = 0, observerErrors = 0;
let spanSequence = 0;
const identities = new WeakMap<object, number>();
let identity = 0;
function id(value: object) {
  let found = identities.get(value);
  if (!found) identities.set(value, found = ++identity);
  return found;
}
function record(kind: string, data: unknown = null) {
  try {
    const row = { seq: ++seq, utc: new Date().toISOString(), ms: performance.now(), kind, data };
    if (rows.length === cap) { rows.shift(); dropped++; }
    rows.push(row);
  } catch { observerErrors++; }
}
function fields(s: any) {
  if (!s) return { present: false, failed: ['present'], idle: false };
  const tests: Record<string, boolean> = {
    connection: s.connection === 'connected', execution: s.execution === 'idle',
    sending: !s.sending, loading: !s.loading, loadingOlder: !s.loadingOlder,
    interruptRequested: !s.interruptRequested, permissions: !s.permissions.length,
    questions: !s.questions.length, unsupportedForms: !s.unsupportedForms.length,
  };
  return { present: true, sessionID: s.sessionID, model: s.model ?? null, connection: s.connection, execution: s.execution,
    sending: s.sending, loading: s.loading, loadingOlder: s.loadingOlder,
    interruptRequested: s.interruptRequested, permissions: s.permissions.length,
    questions: s.questions.length, unsupportedForms: s.unsupportedForms.length,
    sessionOperationPending: s.sessionOperationPending ?? null,
    idle: Object.values(tests).every(Boolean), failed: Object.keys(tests).filter(k => !tests[k]) };
}
function promise<T>(kind: string, value: Promise<T>, metadata: unknown = null): Promise<T> {
  const span = ++spanSequence;
  record(kind + '.pending', {span, metadata});
  // Side branch only. Original Promise, return value and rejection remain untouched.
  void value.then(result => record(kind + '.fulfilled', {
    span, metadata, status: result instanceof Response ? result.status : undefined,
  }), error => record(kind + '.rejected', { span, metadata, error: String(error) }));
  return value;
}
const seenChats = new WeakSet<object>();
function attach(chat: any, owner: object, service: object) {
  if (seenChats.has(chat)) return;
  seenChats.add(chat);
  const meta = { chat: id(chat), owner: id(owner), service: id(service) };
  record('chat.attach', meta);
  const snapshot = () => record('chat.snapshot', { ...meta, ...fields(chat.getSnapshot()) });
  snapshot(); chat.subscribe(snapshot); // Controller already clears all listeners on dispose.
}
function checkpoint(label: string, snapshot: unknown) { record('checkpoint.' + label, fields(snapshot)); }
// Source/native payloads are opt-in exact owned-cohort snapshots, separately capped.
const captures: { seq: number; kind: string; data: unknown }[] = [];
let captureDropped = 0;
function capture(kind: string, data: unknown) {
  try {
    const bytes = kind.startsWith('source.')
      ? Object.values(data as Record<string, Uint8Array>).reduce((sum, b) => sum + b.byteLength, 0)
      : new TextEncoder().encode(JSON.stringify(data)).byteLength;
    if (bytes > 8 * 1024 * 1024) { captureDropped++; record('observer.capture.over-cap', {kind, bytes}); return; }
    if (captures.length === 12) { captures.shift(); captureDropped++; }
    captures.push({ seq: seq + 1, kind, data: structuredClone(data) });
    record(kind + '.captured');
  } catch (error) { record('observer.capture.error', String(error)); observerErrors++; }
}
const nativeWorker = globalThis.Worker;
const nativeTerminate = nativeWorker.prototype.terminate;
const workers = new WeakMap<Worker, { worker: number; url: string; name?: string; owner: string }>();
const wrappedWorker = new Proxy(nativeWorker, {
  construct(target, args, newTarget) {
    record('worker.construct.enter', { url: String(args[0]), name: args[1]?.name, owner: location.href });
    try {
      const worker = Reflect.construct(target, args, newTarget) as Worker;
      const meta = { worker: id(worker), url: String(args[0]), name: args[1]?.name, owner: location.href };
      workers.set(worker, meta); record('worker.construct.return', meta);
      return worker;
    } catch (error) { record('worker.construct.throw', String(error)); throw error; }
  },
});
nativeWorker.prototype.terminate = function(this: Worker) {
  record('worker.terminate.enter', workers.get(this) ?? { worker: id(this), owner: 'unobserved construction' });
  try {
    const result = Reflect.apply(nativeTerminate, this, []);
    record('worker.terminate.return', { worker: id(this), returnType: typeof result });
    return result;
  } catch (error) { record('worker.terminate.throw', { worker: id(this), error: String(error) }); throw error; }
};
globalThis.Worker = wrappedWorker;
Object.defineProperty(globalThis, '__editorSaveCloseTrace', { value: Object.freeze({
  record, promise, attach, checkpoint, capture,
  read: () => structuredClone({ rows, captures, dropped, captureDropped, observerErrors, cap,
    limits: ['host page Worker constructors only; nested workers require CDP census',
      'HTTP receipt is headers/Promise settlement, not body consumption',
      'host-error notification handlers are not individually instrumented'] }),
}), configurable: false, writable: false });
record('observer.installed', { nativeWorkerWrapped: true, beforeRuntimeImports: true });
