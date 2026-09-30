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
    if (state.clearing) throw new WorkspaceError("STORAGE_BUSY", "Workspace is being cleared");
    if (state.attached) throw new WorkspaceError("ATTACHED", "Workspace already has an active runtime");
    if (JSON.stringify(state.distribution) !== JSON.stringify(options.distribution)) throw new WorkspaceError("DISTRIBUTION_MISMATCH", "Runtime must use the workspace distribution");
    state.attached = true;
    const host = state.host;
    let stopped = false;
    const executions = new Set<Execution>();
    const pendingLaunches = new Set<Promise<Execution>>();
    const endpoints = new Set<Endpoint>();
    const endpointFailures: unknown[] = [];
    const executionFailures: unknown[] = [];
    const lifetime = new AbortController();
    const check = () => { if (stopped) throw new WorkspaceError("CLOSED", "Runtime stopped"); };
    const node = async (launchOptions: NodeLaunchOptions, binding?: Record<string, unknown>): Promise<Execution> => {
      check();
      const signal = launchOptions.signal ? AbortSignal.any([launchOptions.signal, lifetime.signal]) : lifetime.signal;
      // Every entrypoint runs in the browser guest, including agent servers whose
      // shell/JS children inherit this environment rather than the preview's.
      const env = { ...launchOptions.env, BROWSER_AGENT_GUEST: "1" };
      const promise = launch(host, { ...launchOptions, env, signal }, binding);
      pendingLaunches.add(promise);
      try {
        const execution = await promise;
        executions.add(execution);
        void execution.exited.then(result => {
          // A process can finish before Runtime.stop. Its failed egress cleanup
          // receipt must survive removal from the live execution registry.
          if (result.cleanupError) executionFailures.push(new Error(result.cleanupError));
          executions.delete(execution);
        }, error => { executionFailures.push(error); executions.delete(execution); });
        if (stopped) await execution.stop();
        return execution;
      } catch (error) {
        // A pre-PID kernel loader can fail cleanup before an Execution exists.
        // Keep that receipt after pending-launch removal; stop must not detach
        // merely because allSettled observed and discarded its rejection.
        if (error instanceof WorkspaceError && error.code === "CLEANUP_FAILED") executionFailures.push(error);
        throw error;
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
        const listenerId = await host.waitForListener(port, signal);
        check();
        const endpoint = createEndpoint(host, port, listenerId, lifetime.signal);
        if (!endpoint.settled || typeof endpoint.settled.then !== "function") {
          endpoint.dispose();
          const error = new Error("Host SDK lacks endpoint cleanup receipts; ownership unproven");
          endpointFailures.push(error);
          throw error;
        }
        endpoints.add(endpoint);
        void endpoint.settled.then(() => endpoints.delete(endpoint), error => {
          endpointFailures.push(error); endpoints.delete(endpoint);
        });
        return endpoint;
      },
      stop() {
        return stopping ??= (async () => {
          stopped = true; lifetime.abort(new WorkspaceError("CLOSED", "Runtime stopped"));
          for (const endpoint of endpoints) endpoint.dispose();
          await Promise.allSettled([...pendingLaunches]);
          const results = await Promise.allSettled([
            ...[...executions].map(e => e.stop()),
            ...[...endpoints].map(endpoint => endpoint.settled),
          ]);
          const failures = [...endpointFailures, ...executionFailures];
          for (const result of results) if (result.status === "rejected") failures.push(result.reason);
          if (failures.length) throw new AggregateError([...new Set(failures)], "Runtime cleanup failed; workspace remains attached");
          state.attached = false;
        })();
      },
    };
    const context: ToolContext = {
      node,
      async installTree(tree) {
        check();
        return host.installTree(tree);
      },
      ...(host.features.has("install-tree-image-v1") ? { async installTreeImage(tree: Parameters<NonNullable<ToolContext["installTreeImage"]>>[0]) {
        check();
        return host.installTreeImage(tree);
      } } : {}),
      async readFile(path) { check(); return host.readFile(path); },
      async installFile(path, bytes) {
        check();
        const stat = await host.stat(path);
        if (stat.exists) {
          const existing = await context.readFile(path);
          if (existing.length !== bytes.length || existing.some((b, i) => b !== bytes[i])) throw new Error(`Bundle conflict: ${path}`);
          return;
        }
        await host.writeFile(path, bytes);
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
