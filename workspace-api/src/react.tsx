import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Workspace, Runtime, WorkspaceError, opfsStore, type Distribution, type Endpoint, type ErrorCode, type Execution, type NodeLaunchOptions, type ToolSet } from "@kev-browser-agent-kit/workspace";
import { createControllerDiagnostics, createDiagnosticScope, safeText, type ControllerDiagnosticOptions } from "./react-diagnostics.js";
import { shutdownAtEOF } from "./service-shutdown.js";
import { budget, timeoutMs as validTimeout, within, type Budget } from "./deadline.js";
import { createProcessOutput } from "./process-output.js";
import { readinessBudget, type ServiceReadiness } from "./service-readiness.js";
export type { ServiceReadiness } from "./service-readiness.js";

/** Reusable React boundary: public API ownership, serialization and subscriptions.
 * No sample source, package paths, provider configuration or application ports here. */
export type Connection = { url: string; fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
export type Service = { execution: Execution; endpoint: Endpoint; connection: Connection; drained: Promise<void>; failed: Promise<never> };
export type ServiceLifecycle = { shutdown: 'stdin-eof'; timeoutMs?: number };
export type Progress = { label: string; state: "waiting" | "running" | "done" | "failed" };
export type WorkspaceSnapshot = {
  workspace?: Workspace; runtime?: Runtime; services: Readonly<Record<string, Service>>;
  clients: Readonly<Record<string, string>>; busy: boolean; status: string; error: string;
  /** WorkspaceError code behind `error`, when it has one (e.g. STORAGE_BUSY, CLEANUP_FAILED). */
  errorCode?: ErrorCode;
  progress: Progress[]; logs: string[]; persistence: string;
};
const initial = (): WorkspaceSnapshot => ({ services: {}, clients: {}, busy: false, status: "Ready", error: "", progress: [], logs: [], persistence: "closed" });
export type WorkspaceControllerOptions = ControllerDiagnosticOptions & {
  /** Bound on waiting for cancelled or stopping work that never settles: a cancelled
   * operation, service stops (after any stdin-EOF budget) and the runtime. Default 10000.
   * stopRuntime, like a close, is bounded by closeTimeoutMs instead. */
  stopTimeoutMs?: number;
  /** One budget for a whole close (close, cancelAndClose, dispose): every stage waits
   * only what is left of it, and a slice is kept back for the kernel's own shutdown
   * and flush. Inside a close, stopTimeoutMs and service EOF budgets are clipped to it.
   * Default 15000. */
  closeTimeoutMs?: number;
};
/** Cleanup bookkeeping of one workspace lifetime (open to close). Each registry empties
 * itself as its work settles, so a retry joins only what is still outstanding;
 * `receipts` are failures of work that is already gone, taken by the next join. A close
 * retires the ledger: whatever the dead lifetime's work does afterwards is a
 * diagnostic, never a failure of the next workspace. */
interface CleanupLedger {
  retired: boolean;
  launches: Set<Promise<unknown>>;
  /** Service stops still running, including ones a deadline stopped waiting for. */
  stops: Set<Promise<void>>;
  settlements: Set<Promise<unknown>>;
  receipts: unknown[];
  /** A join here already ran out its deadline and has not completed since. */
  stalled: { services: boolean; runtime: boolean };
}
const cleanupLedger = (): CleanupLedger => ({ retired: false, launches: new Set(), stops: new Set(), settlements: new Set(), receipts: [], stalled: { services: false, runtime: false } });
/** With work already known to be hung, force only re-checks it this long before forcing. */
const FORCE_RECHECK_MS = 250;
/** Kept back from a close budget for the kernel's shutdown/flush (or the forced flush). */
const closeReserve = (totalMs: number) => Math.min(5_000, totalMs / 3);
/** The code of a WorkspaceError, also one thrown by another copy of the host SDK. */
function workspaceErrorCode(error: unknown): ErrorCode | undefined {
  if (error instanceof WorkspaceError) return error.code;
  const value = error as { name?: unknown; code?: unknown } | null;
  return value?.name === "WorkspaceError" && typeof value.code === "string" ? value.code as ErrorCode : undefined;
}
/** First coded error behind `error`: context wrappers and aggregates must not hide it. */
function causeCode(error: unknown, depth = 0): ErrorCode | undefined {
  if (error == null || depth > 6) return;
  const code = workspaceErrorCode(error);
  if (code) return code;
  const { cause, errors } = error as { cause?: unknown; errors?: unknown };
  for (const inner of [cause, ...(Array.isArray(errors) ? errors : [])]) {
    const found = causeCode(inner, depth + 1);
    if (found) return found;
  }
}
const message = (error: unknown) => safeText(error instanceof Error ? error.message : String(error));

export class WorkspaceController {
  private readonly diagnostics;
  private readonly captureProcessOutput;
  private readonly stopTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  constructor(options: WorkspaceControllerOptions = {}) {
    this.diagnostics = createControllerDiagnostics(options);
    this.captureProcessOutput = options.captureProcessOutput ?? false;
    this.stopTimeoutMs = validTimeout(options.stopTimeoutMs, 10_000, "stopTimeoutMs");
    this.closeTimeoutMs = validTimeout(options.closeTimeoutMs, 15_000, "closeTimeoutMs");
  }
  private snapshot = initial();
  private listeners = new Set<() => void>();
  private attachments = new Map<string, () => void>();
  private shutdowns = new Map<string, { run: (limitMs: number) => Promise<void>; budgetMs: number }>();
  private cleanup = cleanupLedger();
  private clients = new Map<string, { resolve(): void; reject(error: Error): void; promise: Promise<void> }>();
  private distribution?: Distribution;
  private lifetime = new AbortController();
  private operation?: Promise<void>;
  /** The close in flight. `forced` is set once it is on the forced path, whether it
   * started there or a later force call pre-empted its waits. */
  private closeState?: { promise: Promise<void>; work: Promise<void>; preempt: AbortController; forced?: Promise<void> };
  private get closing() { return this.closeState?.promise; }
  /** Budget of the latest close; a forced fallback spends what is left of it. */
  private closeBudget?: Budget;
  private disposal?: Promise<void>;
  private disposed = false;
  private stage = -1;
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get signal() { return this.lifetime.signal; }
  get workspace() { return this.snapshot.workspace; }
  get runtime() { return this.snapshot.runtime; }
  /** Structured recipe/tool events share the active operation's run ID. */
  diagnostic = (event: string, data?: unknown) => this.diagnostics.record(event, data);
  get diagnosticRunId() { return this.diagnostics.runId; }
  private publish(patch: Partial<WorkspaceSnapshot>) { this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) listener(); }
  private appendLog(line: string) { this.publish({ logs: [...this.snapshot.logs, `${new Date().toLocaleTimeString()} ${safeText(line)}`].slice(-2000) }); }
  log = (line: string) => { this.diagnostics.record("activity", { message: line }); this.appendLog(line); };
  status = (status: string) => { this.publish({ status }); this.log(status); };
  reportError = (error: unknown) => { this.publish({ error: message(error), errorCode: causeCode(error) }); this.log(message(error)); };
  notifyPersistence = () => this.publish({ persistence: this.workspace?.persistence.status ?? "closed" });

  /** A synchronous lock excludes double clicks and competing lifecycle actions. */
  run(label: string, task: () => Promise<void>): Promise<void> {
    const diagnostics = this.diagnostics;
    if (this.closing || this.operation || this.disposed) return this.closing ?? this.operation ?? Promise.resolve();
    diagnostics.begin();
    const started = performance.now();
    diagnostics.record("operation.start", { label });
    this.stage = -1;
    this.publish({ busy: true, error: "", errorCode: undefined, status: label });
    this.operation = Promise.resolve().then(task).catch(error => {
      const progress = this.snapshot.progress.map((step, index) => index === this.stage ? { ...step, state: "failed" as const } : step);
      const reason = message(error);
      diagnostics.record("operation.failed", { label, stage: this.snapshot.progress[this.stage]?.label, elapsedMs: Math.round(performance.now() - started), error });
      const hint = /timed out|timeout/i.test(reason) ? " Keep this tab visible and retry; existing files are retained. Download diagnostics for the timed stage and last observed milestone." : "";
      const detail = `${this.stage >= 0 ? this.snapshot.progress[this.stage]?.label + ": " : ""}${reason}${hint}`;
      this.publish({ error: detail, errorCode: causeCode(error), progress }); this.status("Startup/action failed. Fix the reported issue, then retry; completed stages and files are retained.");
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
      const heartbeat = setInterval(() => diagnostics.record('stage.waiting', { label, elapsedMs: Math.round(performance.now() - started) }), 5000);
      try { await task(); this.signal.throwIfAborted(); }
      finally { clearInterval(heartbeat); }
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
    }).catch(error => { this.publish({ persistence: "closed" }); 
      // Keep the code (e.g. STORAGE_BUSY from a lock timeout) through the added context,
      // on the error and in its text: most applications only ever show the message.
      const code = workspaceErrorCode(error), stage = { lastStage, elapsedMs: Math.round(performance.now() - started) };
      const detail = `Workspace.open${code ? ` (${code})` : ""}: ${message(error)}; last stage ${stage.lastStage}, elapsed ${stage.elapsedMs}ms`;
      throw Object.assign(code ? new WorkspaceError(code, detail) : new Error(detail), { cause: error, ...stage });
    }).finally(() => clearInterval(heartbeat));
    if (this.signal.aborted) { await workspace.close(); this.signal.throwIfAborted(); }
    this.distribution = distribution;
    this.publish({ workspace, persistence: workspace.persistence.status });
    return workspace;
  }
  async startRuntime<T extends ToolSet>(tools: T): Promise<Runtime<T>> {
    if (!this.workspace || !this.distribution) throw Error("Open a workspace before starting its runtime");
    if (this.runtime) throw Error("Runtime already started; reuse its existing tools or stop it first");
    const runtime = await Runtime.start({ workspace: this.workspace, distribution: this.distribution, tools, signal: this.signal, stopTimeoutMs: this.stopTimeoutMs });
    this.publish({ runtime }); return runtime;
  }
  private async drain(stream: AsyncIterable<Uint8Array>, label: string) {
    const diagnostics = this.diagnostics;
    const capture = () => typeof this.captureProcessOutput === 'function' ? this.captureProcessOutput() : this.captureProcessOutput;
    const output = createProcessOutput(text => {
      this.appendLog(`[${label}] ${text}`);
      if (capture()) diagnostics.record('guest.output', { label, message: text });
    });
    let totalBytes = 0;
    try { for await (const bytes of stream) { if (!totalBytes) diagnostics.record("guest.first-output", { label, bytes: bytes.length }); totalBytes += bytes.length; output.push(bytes); } }
    catch (error) { this.log(`[${label}] ${message(error)}`); throw error; }
    finally { output.flush(); this.log(`[${label}] drained ${totalBytes} bytes (output available in Activity)`); }
  }
  private drainExecution(execution: Execution, name: string) {
    const streams = [this.drain(execution.stdout, `${name}:stdout`), this.drain(execution.stderr, `${name}:stderr`)];
    const failure = Promise.race(streams.map(stream => stream.then(() => new Promise<never>(() => {}))));
    const drained = Promise.allSettled(streams).then(results => {
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (errors.length) throw new AggregateError(errors.map(result => result.reason), `${name} output drain failed`);
    });
    void failure.catch(() => {}); void drained.catch(() => {});
    return {failure, drained};
  }
  launch(name: string, options: NodeLaunchOptions, port: number, connect: (endpoint: Endpoint, signal: AbortSignal) => Promise<Connection>, lifecycle?: ServiceLifecycle, readiness?: ServiceReadiness) {
    const task = this.launchOwned(name, options, port, connect, lifecycle, readiness);
    const { launches } = this.cleanup;
    launches.add(task);
    void task.finally(() => launches.delete(task)).catch(() => {});
    return task;
  }
  private async launchOwned(name: string, options: NodeLaunchOptions, port: number, connect: (endpoint: Endpoint, signal: AbortSignal) => Promise<Connection>, lifecycle?: ServiceLifecycle, readiness?: ServiceReadiness) {
    const diagnostics = this.diagnostics, ledger = this.cleanup;
    const scope = createDiagnosticScope(event => diagnostics.record(event.event, event.data), diagnostics.runId);
    if (this.snapshot.services[name]) return this.snapshot.services[name]!;
    if (!this.runtime) throw Error("Start the runtime before launching services");
    diagnostics.record("service.launch", { name, port, entry: options.entry, args: options.args, cwd: options.cwd });
    const timeoutMs = lifecycle?.timeoutMs ?? 10000;
    if (lifecycle && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000)) throw Error('Service shutdown timeout must be 1–120000ms');
    const budget = readinessBudget(readiness, this.signal);
    diagnostics.record('service.readiness.budget', { name, listenMs: budget.listenMs, connectMs: budget.connectMs, overallMs: budget.overallMs });
    // Cancel incomplete startup immediately. A published EOF-managed service is
    // closed serially by stopService, so lifetime cancellation cannot preempt it.
    const lifetime = this.signal, startup = new AbortController();
    const abortStartup = () => startup.abort(budget.signal.reason);
    if (budget.signal.aborted) { budget.dispose(); budget.signal.throwIfAborted(); }
    budget.signal.addEventListener('abort', abortStartup, { once: true });
    const spawn = Promise.resolve().then(async () => {
      const execution = await this.runtime!.node({ ...options, signal: lifecycle ? startup.signal : AbortSignal.any([lifetime, startup.signal]) });
      // A spawn accepted after cancellation remains owned and must not be published.
      if (budget.signal.aborted) {
        const {drained} = this.drainExecution(execution, name);
        const results = await Promise.allSettled([execution.stop(), drained]);
        for (const result of results) if (result.status === 'rejected') {
          this.receipt(ledger, result.reason, name);
          diagnostics.record('service.cleanup.failed', { name, error: result.reason });
        }
        budget.signal.throwIfAborted();
      }
      return execution;
    });
    const execution = await scope.stage('service.spawn', () => budget.wait(() => spawn), { name }).catch(async error => {
      startup.abort(error);
      // Readiness observation may expire before node accepts the launch. Keep its
      // ownership until late acceptance has been stopped and both streams joined.
      diagnostics.record('service.cleanup.join.start', { name, phase: 'spawn', quiescence: 'unproven' });
      let failed = false;
      await spawn.then(async execution => {
        const {drained} = this.drainExecution(execution, name);
        const cleanup = await Promise.allSettled([execution.stop(), drained]);
        for (const result of cleanup) if (result.status === 'rejected') { failed = true; this.receipt(ledger, result.reason, name); }
      }, cleanupError => diagnostics.record('service.spawn.settled', { name, error: cleanupError }));
      diagnostics.record('service.cleanup.join.settled', { name, phase: 'spawn', failed });
      budget.signal.removeEventListener('abort', abortStartup); budget.dispose(); throw error;
    });
    const {drained, failure: outputFailure} = this.drainExecution(execution, name);
    // A stream error is evidence of process/transport failure, never healthy silence.
    const earlyExit = execution.exited.then(result => { throw Error(`${name} exited during readiness (${JSON.stringify(result)}). Check Activity and launch configuration`); });
    void outputFailure.catch(() => {}); void earlyExit.catch(() => {});
    const controller = new AbortController();
    const pending: Promise<unknown>[] = [];
    const own = <T,>(task: Promise<T>): Promise<T> => { pending.push(task); void task.catch(() => {}); return task; };
    let endpoint: Endpoint | undefined;
    let endpointDisposed = false;
    const disposeEndpoint = () => {
      if (!endpoint || endpointDisposed) return;
      endpointDisposed = true; endpoint.dispose();
    };
    try {
      endpoint = await scope.stage('service.listen', () => budget.stage('listen', signal => Promise.race([
        own(this.runtime!.expose(port, { signal: AbortSignal.any([signal, controller.signal]) }).then(exposed => {
          endpoint = exposed;
          if (signal.aborted) { disposeEndpoint(); signal.throwIfAborted(); }
          // Ownership starts on acceptance, not on winning the exit/output race.
          endpoint = exposed;
          return exposed;
        })),
        earlyExit, outputFailure,
      ])), { name });
      const connection = await scope.stage('service.connect', () => budget.stage('connect', signal => Promise.race([own(connect(endpoint!, signal)), earlyExit, outputFailure])), { name });
      diagnostics.record("service.healthy", { name, port });
      this.signal.throwIfAborted();
      let resolve!: () => void, reject!: (error: Error) => void;
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      void promise.catch(() => {});
      this.clients.set(name, { promise, resolve, reject });
      const failed = Promise.race([earlyExit, outputFailure]);
      void failed.catch(() => {});
      const service = { execution, endpoint, connection, drained, failed };
      const settlement = Promise.allSettled([execution.exited, drained, endpoint.settled]).then(results => {
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (errors.length) throw new AggregateError(errors.map(result => result.reason), `${name} settlement failed`);
      });
      ledger.settlements.add(settlement);
      // A settled join is no longer outstanding; its failure survives as a receipt.
      void settlement.then(() => { ledger.settlements.delete(settlement); }, error => { ledger.settlements.delete(settlement); this.receipt(ledger, error, name); });
      if (lifecycle) this.shutdowns.set(name, { run: limitMs => shutdownAtEOF(execution, drained, Math.max(1, Math.min(timeoutMs, limitMs))), budgetMs: timeoutMs });
      this.publish({ services: { ...this.snapshot.services, [name]: service }, clients: { ...this.snapshot.clients, [name]: "connecting" } });
      const exited = (result: unknown) => {
        this.log(`${name} exited: ${JSON.stringify(result)}`);
        if (this.snapshot.services[name]?.execution !== execution) return;
        this.detach(name); endpoint?.dispose();
        this.publish({ error: `${name} exited. Retry Start workspace to relaunch; see Activity.`, errorCode: undefined });
      };
      void execution.exited.then(exited, error => exited(message(error)));
      void outputFailure.catch(error => {
        if (this.snapshot.services[name]?.execution !== execution) return;
        this.reportError(`${name} output failed: ${message(error)}`);
        this.clientFailed(name, error);
      });
      return service;
    } catch (error) {
      diagnostics.record("service.failed", { name, error });
      startup.abort(error); controller.abort(error); budget.dispose(); disposeEndpoint();
      diagnostics.record('service.cleanup.join.start', { name, phase: 'readiness', quiescence: 'unproven' });
      const cleanup = await Promise.allSettled([execution.stop(), drained, ...pending]);
      // expose may accept after the readiness race; pending above owns acceptance.
      disposeEndpoint();
      const endpointCleanup = await Promise.allSettled(endpoint ? [endpoint.settled] : []);
      let failed = false;
      for (const result of endpointCleanup) if (result.status === 'rejected') { failed = true; this.receipt(ledger, result.reason, name); }
      for (const [index, result] of cleanup.entries()) if (result.status === 'rejected') {
        if (index < 2) { failed = true; this.receipt(ledger, result.reason, name); }
        diagnostics.record('service.cleanup.settled', { name, error: result.reason });
      }
      diagnostics.record('service.cleanup.join.settled', { name, phase: 'readiness', failed });
      throw error;
    }
    finally { controller.abort(); budget.signal.removeEventListener('abort', abortStartup); budget.dispose(); }
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
  /** Detach now; the returned stop rejects with whatever its join could not prove. */
  private beginServiceStop(name: string, graceLimitMs = Infinity) {
    const service = this.snapshot.services[name], shutdown = this.shutdowns.get(name); this.detach(name);
    if (!service) return;
    service.endpoint.dispose();
    const stop = Promise.allSettled([
      shutdown ? shutdown.run(graceLimitMs) : service.execution.stop(), service.drained, service.endpoint.settled,
    ]).then(results => {
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Service cleanup failed; quiescence unproven');
    });
    return { stop, graceMs: shutdown?.budgetMs ?? 0 };
  }
  /** Record a cleanup failure against the lifetime that owned the work. Once that
   * lifetime is closed nothing can act on it, so it is only made observable. */
  private receipt(ledger: CleanupLedger, error: unknown, source: string) {
    if (ledger.retired) this.diagnostics.record('service.cleanup.late', { source, error });
    else ledger.receipts.push(error);
  }
  /** Keep a stop joined by stopServices, its failure surviving as a receipt. */
  private trackStop(stop: Promise<void>, name: string) {
    const ledger = this.cleanup;
    const tracked: Promise<void> = stop.catch(error => { this.receipt(ledger, error, name); }).finally(() => { ledger.stops.delete(tracked); });
    ledger.stops.add(tracked);
  }
  /** The workspace of this lifetime is gone; later settlements of its work are late. */
  private retireCleanup() {
    this.cleanup.retired = true; this.cleanup = cleanupLedger();
  }
  /** Waits the service's stdin-EOF budget, if any, plus stopTimeoutMs at most. */
  async stopService(name: string) {
    const started = this.beginServiceStop(name);
    if (!started) return;
    const deadline = started.graceMs + this.stopTimeoutMs;
    // The rejection is the report; nothing is retained to fail a later attempt. Work
    // still running stays joined through its settlement and the runtime itself.
    if (!(await within(started.stop, deadline)).timedOut) return;
    this.trackStop(started.stop, name);
    throw new WorkspaceError("CLEANUP_FAILED", `Service ${name} did not stop within ${deadline}ms; quiescence unproven`);
  }
  /** Stop every service and the runtime; the workspace stays open. This is a close's
   * first phase without the close, under the bound a close gives it (closeTimeoutMs
   * minus its reserve), so it fails when an Exit would and in the same retryable state. */
  async stopRuntime() {
    await this.stopWithin(budget(Math.max(0, this.closeTimeoutMs - closeReserve(this.closeTimeoutMs))));
  }
  private async stopWithin(stops: Budget, operation?: Promise<void>) {
    // Graceful EOF may use half of it; the rest is for the fallback kill and joins.
    await this.joinServices(stops, stops.remaining() / 2, operation);
    // The one ordering kept: Runtime.stop kills every execution, so it starts only
    // after the services' graceful windows and the launches have been joined.
    await this.stopAttachedRuntime(stops.remaining(), stops.signal);
  }
  private async stopAttachedRuntime(limitMs: number, signal?: AbortSignal) {
    const runtime = this.runtime, waitMs = Math.min(this.stopTimeoutMs, limitMs), ledger = this.cleanup;
    // Runtime.stop carries this deadline itself; a foreign runtime may not.
    if (runtime) {
      const stopped = await within(runtime.stop({ timeoutMs: waitMs }), waitMs, signal).catch(error => {
        // Runtime.stop reports failed cleanup as an AggregateError; this is its deadline.
        if (workspaceErrorCode(error) === "CLEANUP_FAILED") ledger.stalled.runtime = true;
        throw error;
      });
      if (stopped.timedOut) { ledger.stalled.runtime = true; throw new WorkspaceError("CLEANUP_FAILED", `Runtime did not stop within ${Math.round(waitMs)}ms; workspace remains attached`); }
    }
    ledger.stalled.runtime = false;
    this.publish({ runtime: undefined, progress: [] });
    this.status("Runtime stopped. Files remain open and editable.");
  }
  /** Join startup ownership and service shutdown without closing the workspace.
   * A rejection is never sticky: launches, stops and settlements leave their
   * registries as they settle, so calling again joins only what is still outstanding.
   * One deadline covers the whole join: the longest stdin-EOF budget among the
   * published services (graceful shutdown is not a hang) plus stopTimeoutMs. */
  async stopServices() {
    const graceMs = Math.max(0, ...[...this.shutdowns.values()].map(shutdown => shutdown.budgetMs));
    await this.joinServices(budget(graceMs + this.stopTimeoutMs));
  }
  private async joinServices(deadline: Budget, graceLimitMs = Infinity, operation?: Promise<void>) {
    const started = performance.now(), ledger = this.cleanup;
    const sweep = () => {
      for (const name of Object.keys(this.snapshot.services)) {
        const service = this.beginServiceStop(name, graceLimitMs);
        if (service) this.trackStop(service.stop, name);
      }
    };
    // Every published service is signalled now (stdin EOF or kill), all at once and
    // without waiting for launches or a cancelled operation. Those are joined
    // alongside; only a service one of them still publishes needs the second sweep.
    sweep();
    const join = Promise.allSettled([...ledger.launches, operation]).then(() => { sweep(); return Promise.allSettled([...ledger.stops, ...ledger.settlements]); });
    if ((await within(join, deadline.remaining(), deadline.signal)).timedOut) {
      ledger.stalled.services = true;
      const waiting = { operation: operation && this.operation ? 1 : 0, launches: ledger.launches.size, stops: ledger.stops.size, joins: ledger.settlements.size };
      this.diagnostics.record('service.cleanup.timeout', { waitedMs: Math.round(performance.now() - started), ...waiting });
      throw new WorkspaceError("CLEANUP_FAILED", `Service cleanup timed out with ${waiting.operation} cancelled operation(s), ${waiting.launches} launch(es), ${waiting.stops} service stop(s), ${waiting.joins} service join(s) outstanding; quiescence unproven`);
    }
    ledger.stalled.services = false;
    const failures = ledger.receipts.splice(0);
    if (failures.length) throw new AggregateError([...new Set(failures)], 'Service cleanup failed; quiescence unproven');
  }
  /** Rejects, leaving runtime and workspace in place, while cleanup is unproven; call
   * again to retry. `force` closes regardless: the workspace is flushed and its host
   * destroyed, and the unproven cleanup is still thrown, never reported as success.
   * The whole close spends one closeTimeoutMs budget. */
  async close(options: { force?: boolean } = {}) {
    await this.closeWithin(this.closeBudget = budget(this.closeTimeoutMs), options);
  }
  private async closeWithin(total: Budget, options: { force?: boolean }, operation?: Promise<void>) {
    // Phase 1: everything that can still write stops, under the budget minus the slice
    // reserved for phase 2, so slow stops cannot starve the flush.
    // A force that follows a join which already ran out its deadline does not pay that
    // wait again: it only re-checks, briefly, whether the hung work has since finished.
    const { stalled } = this.cleanup, recheck = options.force && (stalled.services || stalled.runtime);
    const stops = budget(Math.min(recheck ? FORCE_RECHECK_MS : Infinity, Math.max(0, total.remaining() - closeReserve(total.totalMs))), total.signal);
    try { await this.stopWithin(stops, operation); }
    catch (error) { if (!options.force) throw error; return this.forceClose([error]); }
    // Phase 2: the kernel finalizes, flushes and releases storage with all that is left.
    try { await this.workspace?.close({ timeoutMs: Math.max(1, Math.ceil(total.remaining())) }); }
    finally { this.distribution = undefined; this.retireCleanup(); this.publish({ workspace: undefined, persistence: "closed" }); }
    this.status("Workspace flushed and closed. Start workspace restores it.");
  }
  /** Close without waiting on what could not be proven stopped. Always throws: the
   * reasons it was needed, plus anything the forced close itself could not do. The
   * flush gets what is left of the close budget, at most its reserve, at least 1s. */
  private async forceClose(unproven: unknown[]): Promise<never> {
    for (const name of Object.keys(this.snapshot.services)) this.detach(name);
    const flushMs = Math.ceil(Math.min(closeReserve(this.closeTimeoutMs), Math.max(1_000, this.closeBudget?.remaining() ?? 0)));
    try { await this.workspace?.close({ force: true, timeoutMs: flushMs }); }
    catch (error) { unproven.push(error); }
    // Host destruction ended whatever the abandoned runtime still owned. That lifetime
    // is over: its receipts are reported here, and anything later is a diagnostic.
    unproven.push(...this.cleanup.receipts);
    this.retireCleanup(); this.distribution = undefined;
    this.publish({ workspace: undefined, runtime: undefined, progress: [], persistence: "closed" });
    this.status("Workspace force-closed; cleanup was not proven.");
    throw new AggregateError(unproven, `Workspace force-closed; cleanup unproven (${unproven.map(message).join('; ')})`);
  }
  /** Cancel current work immediately and close under one closeTimeoutMs budget. A
   * failed close leaves the controller cancelled; calling again retries the outstanding
   * cleanup, and `force` closes without that proof (see close) - also when a close is
   * already waiting: force ends those waits instead of queueing behind them. Either way
   * a closed controller is reusable. Recipes must observe signal and await all work
   * they start: an operation that outlives the budget fails the close. Do not call
   * inside run(). */
  cancelAndClose(options: { force?: boolean } = {}): Promise<void> {
    const current = this.closeState;
    if (current) {
      if (!options.force || current.forced) return current.forced ?? current.promise;
      current.forced = current.work.then(() => {}, error => this.forceClose([error]));
      current.preempt.abort(new WorkspaceError("CLEANUP_FAILED", "Close was still waiting on cleanup when it was forced; cleanup unproven"));
      return current.forced;
    }
    this.lifetime.abort(new Error("Editing stopped"));
    const preempt = new AbortController(), operation = this.operation;
    const total = this.closeBudget = budget(this.closeTimeoutMs, preempt.signal);
    const work = (async () => {
      for (const dispose of this.attachments.values()) dispose();
      await this.closeWithin(total, options, operation);
    })();
    const state: NonNullable<WorkspaceController["closeState"]> = { work, preempt, forced: options.force ? work : undefined,
      // Every caller of a pre-empted close gets the forced outcome, not the interruption.
      promise: work.catch(error => state.forced ?? Promise.reject(error)).finally(() => {
        this.closeState = undefined;
        if (!this.snapshot.workspace && !this.snapshot.runtime && !this.disposed) this.lifetime = new AbortController();
      }) };
    this.closeState = state;
    return state.promise;
  }
  /** Final: nobody can retry a disposed controller, and a store left open would block
   * every later workspace in the document. So a close that fails or misses a deadline
   * is followed by a forced close, and the unproven cleanup still rejects here. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.diagnostics.record("provider.dispose");
    this.disposed = true;
    // Work already known to be hung is not waited on again (see closeWithin).
    const { stalled } = this.cleanup;
    this.disposal = this.cancelAndClose({ force: stalled.services || stalled.runtime }).catch(error => {
      this.diagnostics.record("provider.dispose.forced", { error });
      // Already closed (by that force, or by a kernel shutdown that failed): just report.
      if (!this.snapshot.workspace && !this.snapshot.runtime) throw error;
      return this.forceClose([error]);
    }).then(() => { this.listeners.clear(); }, error => { this.disposal = undefined; throw error; });
    return this.disposal;
  }
}

const Context = createContext<{ controller: WorkspaceController; state: WorkspaceSnapshot } | null>(null);
export type WorkspaceProviderProps = WorkspaceControllerOptions & { children: ReactNode };
/** Options are captured on mount. This provider starts no workers or services. */
export function WorkspaceProvider({ children, onDiagnostic, captureProcessOutput, stopTimeoutMs, closeTimeoutMs }: WorkspaceProviderProps) {
  const [controller] = useState(() => new WorkspaceController({ onDiagnostic, captureProcessOutput, stopTimeoutMs, closeTimeoutMs }));
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
export function WorkspaceEditing({ onDiagnostic, captureProcessOutput, stopTimeoutMs, closeTimeoutMs, ...props }: WorkspaceEditingProps) {
  return <WorkspaceProvider onDiagnostic={onDiagnostic} captureProcessOutput={captureProcessOutput} stopTimeoutMs={stopTimeoutMs} closeTimeoutMs={closeTimeoutMs}><EditingLifecycle {...props} /></WorkspaceProvider>;
}
function EditingLifecycle({ allowed, enabled, start, retryKey, children, renderEditor, isPreviewReady }: Omit<WorkspaceEditingProps, keyof WorkspaceControllerOptions>) {
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
        void controller.cancelAndClose().catch(error => controller.reportError(new Error(`Cleanup failed; retry Exit: ${message(error)}`, { cause: error })));
        return;
      }
      void (async () => {
        await controller.cancelAndClose();
        if (cancelled || current !== generation.current) return;
        setActive(true);
        await controller.run("Enable editing", () => recipe.current(controller));
      })().catch(error => controller.reportError(new Error(`Editing lifecycle failed: ${message(error)}`, { cause: error })));
    });
    return () => { cancelled = true; };
  }, [controller, desired, retryKey]);
  return <><div hidden={active && desired && !!isPreviewReady?.(state)}>{children}</div>{renderEditor({ controller, state, active: active && desired })}</>;
}
