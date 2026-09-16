import { WorkspaceError, type Distribution } from "./types.js";
import type { diagnosticReporter } from "./diagnostics.js";

// Private transport boundary. Worker protocol never escapes to consumers.
export type Message = { type: string; [key: string]: unknown };
type Listener = (message: Message) => void;
export class Host {
  readonly listeners = new Map<number, string>();
  readonly worker: Worker;
  private handlers = new Set<Listener>();
  private pending = new Map<number, { resolve: (m: Message) => void; reject: (e: Error) => void }>();
  private sequence = 1;
  private dead = false;
  private cleanup: (() => void)[] = [];
  nextExecution = 1;
  readonly features = new Set<string>();
  private constructor(workerUrl: string, readonly serviceWorkerUrl: string) {
    this.worker = new Worker(workerUrl, { type: "module", name: "Workspace storage supervisor" });
    this.worker.onmessage = ({ data: m }: MessageEvent<Message>) => {
      if (m.type === "listen") this.listeners.set(Number(m.port), String(m.listenerId));
      if (m.type === "unlisten") this.listeners.delete(Number(m.port));
      if (m.type === "vv-reply") {
        const p = this.pending.get(Number(m.reqId));
        this.pending.delete(Number(m.reqId));
        if (m.ok === false) p?.reject(new Error(String(m.error)));
        else p?.resolve(m);
      }
      for (const h of this.handlers) h(m);
    };
    this.worker.onerror = (event) => this.destroy(new Error(event.message));
  }
  static async open(distribution: Distribution, signal?: AbortSignal, diagnostics?: ReturnType<typeof diagnosticReporter>): Promise<Host> {
    signal?.throwIfAborted();
    if (!globalThis.crossOriginIsolated) throw new WorkspaceError("BACKEND_UNAVAILABLE", "Workspace requires COOP same-origin and COEP require-corp");
    const base = new URL(distribution.assetBaseUrl.replace(/\/?$/, "/"), location.href);
    diagnostics?.emit("manifest.fetch", { version: distribution.version });
    const response = await fetch(new URL("distribution.json", base), { signal });
    if (!response.ok) throw new Error(`Distribution manifest: HTTP ${response.status}`);
    const manifest = await response.json() as { abi: string; version: string; kernelWorker: string; serviceWorker: string; features?: string[] };
    if (manifest.abi !== "workspace-v1" || manifest.version !== distribution.version) throw new WorkspaceError("DISTRIBUTION_MISMATCH", "Distribution ABI/version mismatch");
    diagnostics?.emit("worker.create");
    const host = new Host(new URL(manifest.kernelWorker, base).href, new URL(manifest.serviceWorker, base).href);
    for (const feature of manifest.features ?? []) host.features.add(feature);
    try {
      await new Promise<void>((resolve, reject) => {
        const milestones = new Set<string>();
        const timer = setTimeout(() => done(new Error("Workspace boot timed out")), 120_000);
        const abort = () => done(signal?.reason ?? new Error("Aborted"));
        const off = host.on(m => {
          // Classify boot output without forwarding arbitrary worker text or paths.
          if (m.type === "log") {
            const category = /\b(opfs|restore|wasm|kernel|mount|snapshot)\b/i.exec(String(m.line))?.[1]?.toLowerCase();
            if (category && !milestones.has(category)) { milestones.add(category); diagnostics?.emit(`worker.log.${category}`); }
          }
          if (m.type === "workspace-persistence") diagnostics?.emit("worker.persistence", { status: m.status });
          if (m.type === "ready") done();
          if (m.type === "host-error") done(new Error(String(m.error)));
          if (m.type === "log" && String(m.line).startsWith("kernel worker boot failed:")) done(new Error(String(m.line)));
        });
        function done(error?: Error) { clearTimeout(timer); off(); signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(); }
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        diagnostics?.emit("worker.init.sent");
        host.post("init", { compress: true });
      });
      diagnostics?.emit("worker.ready");
      return host;
    } catch (error) { host.destroy(); throw error; }
  }
  on(listener: Listener): () => void { this.handlers.add(listener); return () => { this.handlers.delete(listener); }; }
  post(type: string, data: Record<string, unknown> = {}, transfer: Transferable[] = []): void {
    if (this.dead) throw new WorkspaceError("CLOSED", "Workspace host is closed");
    this.worker.postMessage({ type, ...data }, transfer);
  }
  request(type: string, data: Record<string, unknown> = {}): Promise<Message> {
    return new Promise((resolve, reject) => {
      const reqId = this.sequence++;
      this.pending.set(reqId, { resolve, reject });
      try { this.post(type, { ...data, reqId }); } catch (e) { this.pending.delete(reqId); reject(e); }
    });
  }
  private swReady?: Promise<void>;
  registerPreview(): Promise<void> {
    return this.swReady ??= (async () => {
      await navigator.serviceWorker.register(this.serviceWorkerUrl, { scope: "/" });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise<void>((resolve, reject) => {
        const done = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener("controllerchange", done); resolve(); };
        const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener("controllerchange", done); reject(new Error("Service worker did not take control")); }, 10_000);
        navigator.serviceWorker.addEventListener("controllerchange", done);
      });
      const announce = () => {
        navigator.serviceWorker.controller?.postMessage({ type: "vv-kernel-host" });
        navigator.serviceWorker.controller?.postMessage({ type: "vv-devtools", enabled: false });
      };
      const relay = (event: MessageEvent) => {
        if (event.data?.type === "vv-http" && event.ports[0]) this.post("vv-http", { req: event.data.req }, [event.ports[0]]);
      };
      navigator.serviceWorker.addEventListener("message", relay);
      navigator.serviceWorker.addEventListener("controllerchange", announce);
      this.cleanup.push(() => { navigator.serviceWorker.removeEventListener("message", relay); navigator.serviceWorker.removeEventListener("controllerchange", announce); });
      announce();
    })();
  }
  destroy(error: Error = new WorkspaceError("CLOSED", "Workspace closed")): void {
    if (this.dead) return;
    this.dead = true;
    for (const h of this.handlers) h({ type: "host-error", error: error.message });
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear(); this.handlers.clear();
    for (const cleanup of this.cleanup) cleanup();
  }
}
