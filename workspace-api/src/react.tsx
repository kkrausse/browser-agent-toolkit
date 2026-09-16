import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Workspace, Runtime, opfsStore, type Distribution, type Endpoint, type Execution, type NodeLaunchOptions, type ToolSet } from "@kev-browser-agent-kit/workspace";
import { createControllerDiagnostics, safeText, type ControllerDiagnosticOptions } from "./react-diagnostics.js";
import { shutdownAtEOF } from "./service-shutdown.js";

/** Reusable React boundary: public API ownership, serialization and subscriptions.
 * No sample source, package paths, provider configuration or application ports here. */
export type Connection = { url: string; fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
export type Service = { execution: Execution; endpoint: Endpoint; connection: Connection; drained: Promise<void> };
export type ServiceLifecycle = { shutdown: 'stdin-eof'; timeoutMs?: number };
export type Progress = { label: string; state: "waiting" | "running" | "done" | "failed" };
export type WorkspaceSnapshot = {
  workspace?: Workspace; runtime?: Runtime; services: Readonly<Record<string, Service>>;
  clients: Readonly<Record<string, string>>; busy: boolean; status: string; error: string;
  progress: Progress[]; logs: string[]; persistence: string;
};
const initial = (): WorkspaceSnapshot => ({ services: {}, clients: {}, busy: false, status: "Ready", error: "", progress: [], logs: [], persistence: "closed" });
const message = (error: unknown) => safeText(error instanceof Error ? error.message : String(error));

export class WorkspaceController {
  private readonly diagnostics;
  constructor(options: ControllerDiagnosticOptions = {}) { this.diagnostics = createControllerDiagnostics(options); }
  private snapshot = initial();
  private listeners = new Set<() => void>();
  private attachments = new Map<string, () => void>();
  private shutdowns = new Map<string, () => Promise<void>>();
  private clients = new Map<string, { resolve(): void; reject(error: Error): void; promise: Promise<void> }>();
  private distribution?: Distribution;
  private lifetime = new AbortController();
  private operation?: Promise<void>;
  private closing?: Promise<void>;
  private disposal?: Promise<void>;
  private disposed = false;
  private stage = -1;
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get signal() { return this.lifetime.signal; }
  get workspace() { return this.snapshot.workspace; }
  get runtime() { return this.snapshot.runtime; }
  private publish(patch: Partial<WorkspaceSnapshot>) { this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) listener(); }
  log = (line: string) => { this.diagnostics.record("activity", { message: line }); this.publish({ logs: [...this.snapshot.logs, `${new Date().toLocaleTimeString()} ${safeText(line)}`].slice(-160) }); };
  status = (status: string) => { this.publish({ status }); this.log(status); };
  reportError = (error: unknown) => { this.publish({ error: message(error) }); this.log(message(error)); };
  notifyPersistence = () => this.publish({ persistence: this.workspace?.persistence.status ?? "closed" });

  /** A synchronous lock excludes double clicks and competing lifecycle actions. */
  run(label: string, task: () => Promise<void>): Promise<void> {
    const diagnostics = this.diagnostics;
    if (this.closing || this.operation || this.disposed) return this.closing ?? this.operation ?? Promise.resolve();
    diagnostics.begin();
    const started = performance.now();
    diagnostics.record("operation.start", { label });
    this.stage = -1;
    this.publish({ busy: true, error: "", status: label });
    this.operation = Promise.resolve().then(task).catch(error => {
      const progress = this.snapshot.progress.map((step, index) => index === this.stage ? { ...step, state: "failed" as const } : step);
      const reason = message(error);
      diagnostics.record("operation.failed", { label, stage: this.snapshot.progress[this.stage]?.label, elapsedMs: Math.round(performance.now() - started), error });
      const hint = /timed out|timeout/i.test(reason) ? " Keep this tab visible and retry; existing files are retained. Download diagnostics for the timed stage and last observed milestone." : "";
      const detail = `${this.stage >= 0 ? this.snapshot.progress[this.stage]?.label + ": " : ""}${reason}${hint}`;
      this.publish({ error: detail, progress }); this.status("Startup/action failed. Fix the reported issue, then retry; completed stages and files are retained.");
    }).finally(() => { diagnostics.record("operation.end", { label, elapsedMs: Math.round(performance.now() - started), failed: !!this.snapshot.error }); void diagnostics.flush(); this.operation = undefined; this.publish({ busy: false }); });
    return this.operation;
  }
  async steps(steps: [string, () => Promise<void>][]) {
    const diagnostics = this.diagnostics;
    this.publish({ progress: steps.map(([label]) => ({ label, state: "waiting" })) });
    for (const [index, [label, task]] of steps.entries()) {
      this.signal.throwIfAborted(); this.stage = index;
      this.publish({ progress: this.snapshot.progress.map((step, i) => i === index ? { ...step, state: "running" } : step) });
      this.status(`${index + 1}/${steps.length} · ${label}…`);
      const started = performance.now(); diagnostics.record("stage.start", { label });
      await task(); this.signal.throwIfAborted();
      diagnostics.record("stage.ready", { label, elapsedMs: Math.round(performance.now() - started) });
      this.publish({ progress: this.snapshot.progress.map((step, i) => i === index ? { ...step, state: "done" } : step) });
    }
    this.stage = -1;
  }
  async open(distribution: Distribution) {
    const diagnostics = this.diagnostics;
    if (this.workspace) return this.workspace;
    const started = performance.now(); let lastStage = "open.requested";
    const heartbeat = setInterval(() => diagnostics.record("workspace.open.waiting", { lastStage, elapsedMs: Math.round(performance.now() - started) }), 10000);
    const workspace = await Workspace.open({ id: "default", storage: opfsStore(distribution), signal: AbortSignal.any([this.signal, AbortSignal.timeout(120000)]),
      onPersistenceChange: state => { this.publish({ persistence: state.status }); diagnostics.record("persistence", state); },
      onDiagnostic: event => { if (event.stage !== "open.failed") lastStage = event.stage; diagnostics.record("workspace.open", event); },
    }).catch(error => { this.publish({ persistence: "closed" }); throw new Error(`Workspace.open: ${message(error)}; last stage ${lastStage}, elapsed ${Math.round(performance.now() - started)}ms`, { cause: error }); }).finally(() => clearInterval(heartbeat));
    if (this.signal.aborted) { await workspace.close(); this.signal.throwIfAborted(); }
    this.distribution = distribution;
    this.publish({ workspace, persistence: workspace.persistence.status });
    return workspace;
  }
  async startRuntime<T extends ToolSet>(tools: T): Promise<Runtime<T>> {
    if (!this.workspace || !this.distribution) throw Error("Open a workspace before starting its runtime");
    if (this.runtime) throw Error("Runtime already started; reuse its existing tools or stop it first");
    const runtime = await Runtime.start({ workspace: this.workspace, distribution: this.distribution, tools, signal: this.signal });
    this.publish({ runtime }); return runtime;
  }
  private async drain(stream: AsyncIterable<Uint8Array>, label: string) {
    const diagnostics = this.diagnostics;
    let totalBytes = 0;
    try { for await (const bytes of stream) { if (!totalBytes) diagnostics.record("guest.first-output", { label, bytes: bytes.length }); totalBytes += bytes.length; } }
    catch (error) { this.log(`[${label}] ${message(error)}`); }
    finally { this.log(`[${label}] drained ${totalBytes} bytes (raw output omitted from diagnostics)`); }
  }
  async launch(name: string, options: NodeLaunchOptions, port: number, connect: (endpoint: Endpoint) => Promise<Connection>, lifecycle?: ServiceLifecycle) {
    const diagnostics = this.diagnostics;
    if (this.snapshot.services[name]) return this.snapshot.services[name]!;
    if (!this.runtime) throw Error("Start the runtime before launching services");
    diagnostics.record("service.launch", { name, port });
    const timeoutMs = lifecycle?.timeoutMs ?? 10000;
    if (lifecycle && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000)) throw Error('Service shutdown timeout must be 1–120000ms');
    // Cancel incomplete startup immediately. A published EOF-managed service is
    // closed serially by stopService, so lifetime cancellation cannot preempt it.
    const lifetime = this.signal, startup = new AbortController();
    const abortStartup = () => startup.abort(lifetime.reason);
    if (lifecycle) {
      lifetime.throwIfAborted();
      lifetime.addEventListener('abort', abortStartup, { once: true });
    }
    const execution = await this.runtime.node({ ...options, signal: lifecycle ? startup.signal : lifetime }).catch(error => {
      lifetime.removeEventListener('abort', abortStartup); throw error;
    });
    const drained = Promise.all([this.drain(execution.stdout, `${name}:stdout`), this.drain(execution.stderr, `${name}:stderr`)]).then(() => {});
    const controller = new AbortController();
    let endpoint: Endpoint | undefined;
    try {
      endpoint = await Promise.race([
        this.runtime.expose(port, { signal: AbortSignal.any([this.signal, controller.signal, AbortSignal.timeout(30000)]) }),
        execution.exited.then(result => { throw Error(`${name} exited before listening (${JSON.stringify(result)}). Check Activity and launch configuration`); }),
      ]);
      const connection = await connect(endpoint);
      diagnostics.record("service.healthy", { name, port });
      this.signal.throwIfAborted();
      let resolve!: () => void, reject!: (error: Error) => void;
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      void promise.catch(() => {});
      this.clients.set(name, { promise, resolve, reject });
      const service = { execution, endpoint, connection, drained };
      if (lifecycle) this.shutdowns.set(name, () => shutdownAtEOF(execution, drained, timeoutMs));
      this.publish({ services: { ...this.snapshot.services, [name]: service }, clients: { ...this.snapshot.clients, [name]: "connecting" } });
      const exited = (result: unknown) => {
        this.log(`${name} exited: ${JSON.stringify(result)}`);
        if (this.snapshot.services[name]?.execution !== execution) return;
        this.detach(name); endpoint?.dispose();
        this.publish({ error: `${name} exited. Retry Start workspace to relaunch; see Activity.` });
      };
      void execution.exited.then(exited, error => exited(message(error)));
      return service;
    } catch (error) { diagnostics.record("service.failed", { name, error }); endpoint?.dispose(); try { await execution.stop(); await drained; } catch (cleanupError) { diagnostics.record("service.cleanup.failed", { name, error: cleanupError }); } throw error; }
    finally { controller.abort(); lifetime.removeEventListener('abort', abortStartup); }
  }
  registerAttachment(name: string, dispose: () => void) {
    let disposed = false;
    const once = () => { if (disposed) return; disposed = true; dispose(); if (this.attachments.get(name) === once) this.attachments.delete(name); };
    this.attachments.get(name)?.(); this.attachments.set(name, once); return once;
  }
  clientReady(name: string) { this.diagnostics.record("client.ready", { name }); this.clients.get(name)?.resolve(); this.publish({ clients: { ...this.snapshot.clients, [name]: "ready" } }); }
  clientFailed(name: string, error: unknown) { this.diagnostics.record("client.failed", { name, error }); this.clients.get(name)?.reject(new Error(message(error))); this.publish({ clients: { ...this.snapshot.clients, [name]: message(error) } }); }
  async waitForClient(name: string) {
    this.signal.throwIfAborted();
    const client = this.clients.get(name);
    if (!client) throw Error(`No ${name} service to attach`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const aborted = () => client.reject(new Error("Workspace provider stopped"));
    this.signal.addEventListener("abort", aborted, { once: true });
    try { await Promise.race([client.promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`${name} client connection timed out; inspect Activity and retry`)), 45000); })]); }
    finally { clearTimeout(timer); this.signal.removeEventListener("abort", aborted); }
  }
  private detach(name: string) {
    this.shutdowns.delete(name);
    this.attachments.get(name)?.();
    this.clients.get(name)?.reject(new Error(`${name} detached`)); this.clients.delete(name);
    const services = { ...this.snapshot.services }, clients = { ...this.snapshot.clients };
    delete services[name]; delete clients[name]; this.publish({ services, clients });
  }
  async stopService(name: string) {
    const service = this.snapshot.services[name], shutdown = this.shutdowns.get(name); this.detach(name);
    if (!service) return;
    service.endpoint.dispose();
    if (shutdown) await shutdown();
    else { await service.execution.stop(); await service.drained; }
  }
  async stopRuntime() {
    const results = await Promise.allSettled(Object.keys(this.snapshot.services).map(name => this.stopService(name)));
    await this.runtime?.stop(); this.publish({ runtime: undefined, progress: [] });
    for (const result of results) if (result.status === "rejected") this.log(`Service cleanup: ${message(result.reason)}`);
    this.status("Runtime stopped. Files remain open and editable.");
  }
  async close() {
    await this.stopRuntime();
    try { await this.workspace?.close(); }
    finally { this.distribution = undefined; this.publish({ workspace: undefined, persistence: "closed" }); }
    this.status("Workspace flushed and closed. Start workspace restores it.");
  }
  /** Cancel current work immediately, then close serially. Retry after cleanup failure.
   * Recipes must observe signal and await all work they start. Do not call inside run(). */
  cancelAndClose(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort(new Error("Editing stopped"));
    this.closing = (async () => {
      await this.operation;
      for (const dispose of this.attachments.values()) dispose();
      await this.close();
      if (!this.disposed) this.lifetime = new AbortController();
    })().finally(() => { this.closing = undefined; });
    return this.closing;
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.diagnostics.record("provider.dispose");
    this.disposed = true;
    this.disposal = this.cancelAndClose().then(() => { this.listeners.clear(); }, error => { this.disposal = undefined; throw error; });
    return this.disposal;
  }
}

const Context = createContext<{ controller: WorkspaceController; state: WorkspaceSnapshot } | null>(null);
export type WorkspaceProviderProps = ControllerDiagnosticOptions & { children: ReactNode };
/** Options are captured on mount. This provider starts no workers or services. */
export function WorkspaceProvider({ children, onDiagnostic }: WorkspaceProviderProps) {
  const [controller] = useState(() => new WorkspaceController({ onDiagnostic }));
  const mounts = useRef(0);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    mounts.current++;
    const cleanup = () => { void controller.dispose().catch(error => { controller.log(`Workspace cleanup failed: ${message(error)}`); }); };
    window.addEventListener("pagehide", cleanup);
    return () => {
      mounts.current--; window.removeEventListener("pagehide", cleanup);
      // React StrictMode replays effects synchronously; only a real unmount disposes.
      queueMicrotask(() => { if (!mounts.current) cleanup(); });
    };
  }, [controller]);
  return <Context.Provider value={{ controller, state }}>{children}</Context.Provider>;
}
export function useWorkspace() {
  const value = useContext(Context);
  if (!value) throw Error("useWorkspace must be used inside WorkspaceProvider");
  return value;
}
export type { ControllerDiagnosticOptions, ControllerDiagnosticEvent } from "./react-diagnostics.js";

export type WorkspaceEditingProps = WorkspaceProviderProps & {
  /** UI permission only. The application's server must independently authorize assets/tools. */
  allowed: boolean;
  enabled: boolean;
  start(controller: WorkspaceController): Promise<void>;
  /** Increment to retry a failed start, retaining the mounted normal application. */
  retryKey?: number;
  /** Recipe-specific readiness; hides (does not unmount) the normal app once true. */
  isPreviewReady?(state: WorkspaceSnapshot): boolean;
  renderEditor(context: { controller: WorkspaceController; state: WorkspaceSnapshot; active: boolean }): ReactNode;
};
/** Optional controlled boundary. Children retain identity in normal, boot and editing modes.
 * The recipe/editor decide preview readiness and presentation; no runtime or recipe is implicit. */
export function WorkspaceEditing({ onDiagnostic, ...props }: WorkspaceEditingProps) {
  return <WorkspaceProvider onDiagnostic={onDiagnostic}><EditingLifecycle {...props} /></WorkspaceProvider>;
}
function EditingLifecycle({ allowed, enabled, start, retryKey, children, renderEditor, isPreviewReady }: Omit<WorkspaceEditingProps, "onDiagnostic">) {
  const { controller, state } = useWorkspace();
  const desired = allowed && enabled;
  const generation = useRef(0);
  const recipe = useRef(start); recipe.current = start;
  const [active, setActive] = useState(false);
  useEffect(() => {
    const current = ++generation.current;
    let cancelled = false;
    // Deferred admission avoids opening/closing storage during StrictMode effect replay.
    queueMicrotask(() => {
      if (cancelled) return;
      if (!desired) {
        setActive(false);
        void controller.cancelAndClose().catch(error => controller.reportError(`Cleanup failed; retry Exit: ${message(error)}`));
        return;
      }
      void (async () => {
        await controller.cancelAndClose();
        if (cancelled || current !== generation.current) return;
        setActive(true);
        await controller.run("Enable editing", () => recipe.current(controller));
      })().catch(error => controller.reportError(`Editing lifecycle failed: ${message(error)}`));
    });
    return () => { cancelled = true; };
  }, [controller, desired, retryKey]);
  return <><div hidden={active && desired && !!isPreviewReady?.(state)}>{children}</div>{renderEditor({ controller, state, active: active && desired })}</>;
}
