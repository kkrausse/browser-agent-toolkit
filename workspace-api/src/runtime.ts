import { launch } from "./execution.js";
import { createEndpoint } from "./browser/endpoint.js";
import { workspaceInternals, type Workspace } from "./workspace.js";
import { WorkspaceError, type Distribution, type Endpoint, type Execution, type NodeLaunchOptions, type ToolDescriptor, type ToolContext } from "./types.js";

// Function variance permits heterogeneous descriptors without any or untyped calls.
export type ToolSet = Record<string, ToolDescriptor<never, unknown>>;
export type BoundTools<T extends ToolSet> = { [K in keyof T]: Awaited<ReturnType<T[K]["bind"]>> };
export interface Runtime<T extends ToolSet = {}> {
  readonly tools: BoundTools<T>;
  node(options: NodeLaunchOptions): Promise<Execution>;
  expose(port: number, options?: { signal?: AbortSignal }): Promise<Endpoint>;
  stop(): Promise<void>;
}
export interface RuntimeStartOptions<T extends ToolSet = {}> {
  distribution: Distribution;
  workspace: Workspace;
  tools?: T;
  signal?: AbortSignal;
}
export namespace Runtime {
  export async function start<T extends ToolSet = {}>(options: RuntimeStartOptions<T>): Promise<Runtime<T>> {
    options.signal?.throwIfAborted();
    const state = workspaceInternals.get(options.workspace);
    if (!state || state.closed) throw new WorkspaceError("CLOSED", "Workspace is not open");
    if (state.attached) throw new WorkspaceError("ATTACHED", "Workspace already has an active runtime");
    if (JSON.stringify(state.distribution) !== JSON.stringify(options.distribution)) throw new WorkspaceError("DISTRIBUTION_MISMATCH", "Runtime must use the workspace distribution");
    state.attached = true;
    const host = state.host;
    let stopped = false;
    const executions = new Set<Execution>();
    const pendingLaunches = new Set<Promise<Execution>>();
    const endpoints = new Set<Endpoint>();
    const lifetime = new AbortController();
    const check = () => { if (stopped) throw new WorkspaceError("CLOSED", "Runtime stopped"); };
    const node = async (launchOptions: NodeLaunchOptions, binding?: Record<string, unknown>): Promise<Execution> => {
      check();
      const signal = launchOptions.signal ? AbortSignal.any([launchOptions.signal, lifetime.signal]) : lifetime.signal;
      const promise = launch(host, { ...launchOptions, signal }, binding);
      pendingLaunches.add(promise);
      try {
        const execution = await promise;
        executions.add(execution);
        void execution.exited.then(() => executions.delete(execution));
        if (stopped) await execution.stop();
        return execution;
      } finally { pendingLaunches.delete(promise); }
    };
    let stopping: Promise<void> | undefined;
    const runtime: Runtime<T> = {
      tools: {} as BoundTools<T>, node,
      async expose(port, opts = {}) {
        check();
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError("Invalid port");
        const signal = opts.signal ? AbortSignal.any([opts.signal, lifetime.signal]) : lifetime.signal;
        signal.throwIfAborted();
        const listenerId = await new Promise<string>((resolve, reject) => {
          const abort = () => { off(); reject(signal.reason); };
          const finish = (id: string) => { off(); signal.removeEventListener("abort", abort); resolve(id); };
          const off = host.on(m => {
            if (m.type === "listen" && m.port === port) finish(String(m.listenerId));
            if (m.type === "host-error") { off(); signal.removeEventListener("abort", abort); reject(new Error(String(m.error))); }
          });
          signal.addEventListener("abort", abort, { once: true });
          const existing = host.listeners.get(port);
          if (existing) finish(existing);
        });
        check();
        const endpoint = createEndpoint(host, port, listenerId, lifetime.signal);
        endpoints.add(endpoint);
        void endpoint.closed.then(() => endpoints.delete(endpoint));
        return endpoint;
      },
      stop() {
        return stopping ??= (async () => {
          stopped = true; lifetime.abort(new WorkspaceError("CLOSED", "Runtime stopped"));
          for (const endpoint of endpoints) endpoint.dispose();
          await Promise.allSettled([...pendingLaunches]);
          await Promise.all([...executions].map(e => e.stop()));
          state.attached = false;
        })();
      },
    };
    const context: ToolContext = {
      node,
      async installTree(tree) {
        check();
        if (!host.features.has("install-tree-v1")) throw new Error("Runtime lacks bulk tree installation; rebuild its distribution and editor preparation");
        const result = await host.request("workspace-install-tree", tree);
        return { files: Number(result.files), verifyMs: Number(result.verifyMs), installMs: Number(result.installMs), readbackMs: Number(result.readbackMs) };
      },
      async readFile(path) { check(); return (await host.request("workspace-read", { path })).bytes as Uint8Array; },
      async installFile(path, bytes) {
        check();
        const stat = await host.request("vv-stat", { path });
        if (stat.exists) {
          const existing = await context.readFile(path);
          if (existing.length !== bytes.length || existing.some((b, i) => b !== bytes[i])) throw new Error(`Bundle conflict: ${path}`);
          return;
        }
        await host.request("workspace-write", { path, bytes });
      },
    };
    try {
      for (const [name, descriptor] of Object.entries(options.tools ?? {})) {
        const method = await descriptor.bind(context);
        Object.defineProperty(runtime.tools, name, { enumerable: true, value: (arg: never) => { check(); return method(arg); } });
      }
      options.signal?.throwIfAborted();
      return runtime;
    } catch (error) { await runtime.stop(); throw error; }
  }
}
