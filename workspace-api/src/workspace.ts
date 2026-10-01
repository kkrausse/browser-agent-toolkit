import { Host } from "./host.js";
import { diagnosticReporter } from "./diagnostics.js";
import { timeoutMs, within } from "./deadline.js";
import { WorkspaceError, type Distribution, type PersistenceState, type WorkspaceCloseOptions, type WorkspaceDiagnostics, type WorkspaceFs, type WorkspaceOpenOptions, type WorkspaceStorage } from "./types.js";

export function opfsStore(distribution: Distribution): WorkspaceStorage { return { kind: "opfs", distribution }; }
export function workspacePath(path: string): string {
  if (!path.startsWith("/") || path.includes("\0") || path.split("/").includes("..")) throw new Error("Expected an absolute workspace path without '..'");
  return "/workspace" + (path === "/" ? "" : path.replace(/\/+$/, ""));
}
let opening = false;
export interface Workspace {
  readonly id: string;
  readonly fs: WorkspaceFs;
  readonly persistence: PersistenceState;
  flush(): Promise<void>;
  /** Rejects with ATTACHED while a runtime is attached; stop (or retry stopping) it first.
   * `{ force: true }` closes anyway and rejects with CLEANUP_FAILED once it has. */
  close(options?: WorkspaceCloseOptions): Promise<void>;
}
type WorkspaceInternalState = { host: Host; distribution: Distribution; attached: boolean; clearing: boolean; closed: boolean;
  /** Retries the stop of a runtime whose failed start left the caller without a handle. */
  unstopped?: () => Promise<void> };
export const workspaceInternals = new WeakMap<Workspace, WorkspaceInternalState>();

/** Return a read-only snapshot of the live guest processes and kernel activity. */
export async function diagnoseWorkspace(workspace: Workspace): Promise<WorkspaceDiagnostics> {
  const state = workspaceInternals.get(workspace);
  if (!state || state.closed) throw new WorkspaceError("CLOSED", "Workspace is not open");
  const reply = await state.host.request("vv-diag");
  return reply.diag as WorkspaceDiagnostics;
}

/** Read-only lstat/readlink evidence; unlike fs.stat this never follows a leaf symlink.
 * Directory names still use the runtime's existing readdir framing, not raw VFS access. */
export async function diagnoseWorkspaceEntry(workspace: Workspace, path: string): Promise<{path: string; metadata: Record<string, unknown>; names?: string[]; target?: string}> {
  const state = workspaceInternals.get(workspace);
  if (!state || state.closed) throw new WorkspaceError("CLOSED", "Workspace is not open");
  if (state.clearing) throw new WorkspaceError("STORAGE_BUSY", "Workspace is being cleared");
  const absolute = workspacePath(path);
  const reply = await state.host.request("vv-git-fs", { op: "lstat", args: { path: absolute } });
  const metadata = reply.result as Record<string, unknown>;
  if (metadata.kind === "symlink") {
    const link = await state.host.request("vv-git-fs", { op: "readlink", args: { path: absolute } });
    return {path, metadata, target: link.result as string};
  }
  return { path, metadata, ...(metadata.kind === "dir" ? { names: await state.host.readdir(absolute) } : {}) };
}

const CLEAR_ROOTS = ["/workspace", "/.server"] as const;

function childPath(parent: string, name: string): string {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new Error(`Invalid directory entry while clearing ${parent}`);
  }
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

async function removeDescendants(host: Host, root: string): Promise<void> {
  const describeFailure = (operation: string, path: string, error: unknown) => {
    const cause = error instanceof Error ? error.message : String(error);
    return new Error(`Workspace clear failed while ${operation} ${path}: ${cause}`, { cause });
  };
  let stat;
  try { stat = await host.stat(root); }
  catch (error) { throw describeFailure("inspecting", root, error); }
  if (!stat.exists) return;
  if (!stat.isDirectory) {
    try { await host.remove(root); }
    catch (error) { throw describeFailure("removing", root, error); }
    return;
  }
  let names: string[];
  try { names = await host.readdir(root); }
  catch (error) { throw describeFailure("listing", root, error); }
  for (const name of names) {
    const path = childPath(root, name);
    // The runtime owns recursive deletion and classifies entries with lstat.
    // Walking here with stat would follow directory symlinks outside this root.
    try { await host.remove(path); }
    catch (error) { throw describeFailure("removing", path, error); }
  }
}

/**
 * Durably clears project files and OpenCode server state from an open workspace.
 * The caller must stop the attached runtime before invoking this operation.
 */
export async function clearWorkspace(workspace: Workspace): Promise<void> {
  const state = workspaceInternals.get(workspace);
  if (!state || state.closed) throw new WorkspaceError("CLOSED", "Workspace is not open");
  if (state.attached) throw new WorkspaceError("ATTACHED", "Stop the attached runtime before clearing Workspace");
  if (state.clearing) throw new WorkspaceError("STORAGE_BUSY", "Workspace is already being cleared");
  state.clearing = true;
  try {
    for (const root of CLEAR_ROOTS) await removeDescendants(state.host, root);
    await state.host.flush();
    for (const root of CLEAR_ROOTS) {
      const stat = await state.host.stat(root);
      if (stat.exists && (!stat.isDirectory || (await state.host.readdir(root)).length !== 0)) {
        throw new Error(`Workspace clear verification failed for ${root}`);
      }
    }
  } finally {
    state.clearing = false;
  }
}

export namespace Workspace {
  export async function open(options: WorkspaceOpenOptions): Promise<Workspace> {
    if (options.id !== "default") throw new WorkspaceError("UNSUPPORTED_WORKSPACE", "Only workspace id 'default' is supported (one origin store)");
    if (options.storage.kind !== "opfs") throw new WorkspaceError("BACKEND_UNAVAILABLE", "Expected opfsStore(distribution)");
    if (opening) throw new WorkspaceError("STORAGE_BUSY", "A workspace is already open in this document");
    opening = true;
    options.onPersistenceChange?.({ status: "opening" });
    let host: Host | undefined;
    const aborted = () => host?.destroy(options.signal?.reason instanceof Error ? options.signal.reason : new Error("Workspace open aborted"));
    const diagnostics = diagnosticReporter(options.onDiagnostic);
    diagnostics.emit("open.requested", { version: options.storage.distribution.version });
    try {
      host = await Host.open(options.storage.distribution, options.signal, diagnostics);
      options.signal?.addEventListener("abort", aborted, { once: true });
      if (options.signal?.aborted) { aborted(); options.signal.throwIfAborted(); }
      const h = host;
      diagnostics.emit("persistence.query");
      let persistence = await h.persistence();
      diagnostics.emit("persistence.result", { status: persistence.status });
      // A failed lease/init never silently opens someone else's store in RAM.
      if (persistence.status !== "durable") throw new WorkspaceError("STORAGE_BUSY", persistence.status === "failed" ? persistence.error : "Persistent storage unavailable");
      diagnostics.emit("workspace.directory");
      await h.mkdir("/workspace");
      const state: WorkspaceInternalState = { host: h, distribution: options.storage.distribution, attached: false, clearing: false, closed: false };
      let closing: Promise<void> | undefined;
      const check = () => {
        if (state.closed) throw new WorkspaceError("CLOSED", "Workspace closed");
        if (state.clearing) throw new WorkspaceError("STORAGE_BUSY", "Workspace is being cleared");
      };
      const watches = new Set<(event: { paths: string[] }) => void>();
      const offPersistence = h.onPersistence(value => { persistence = value; options.onPersistenceChange?.(value); });
      const offMutation = h.onMutation(path => {
        if (path === "/workspace" || path.startsWith("/workspace/")) {
          for (const listener of watches) listener({ paths: [path.slice(10) || "/"] });
        }
      });
      const off = () => { offPersistence(); offMutation(); };
      const workspace: Workspace = {
        id: options.id,
        get persistence() { return persistence; },
        fs: {
          async readFile(path) { check(); return h.readFile(workspacePath(path)); },
          async writeFile(path, bytes) { check(); await h.writeFile(workspacePath(path), bytes); },
          async stat(path) {
            check();
            const m = await h.stat(workspacePath(path));
            if (!m.exists) throw new Error(`ENOENT: ${path}`);
            return { isDirectory: m.isDirectory, isFile: m.isFile, size: m.size };
          },
          async readdir(path) { check(); return h.readdir(workspacePath(path)); },
          async mkdir(path) { check(); await h.mkdir(workspacePath(path)); },
          async rename(from, to) { check(); if (from === "/" || to === "/") throw new Error("Cannot rename workspace root"); await h.rename(workspacePath(from), workspacePath(to)); },
          async remove(path) { check(); if (path === "/") throw new Error("Cannot remove workspace root"); await h.remove(workspacePath(path)); },
          watch(listener) { check(); watches.add(listener); return () => { watches.delete(listener); }; },
        },
        async flush() { check(); await h.flush(); },
        close(closeOptions = {}) {
          if (closing) return closing;
          let flushMs: number;
          try { flushMs = timeoutMs(closeOptions.timeoutMs, 10_000, "timeoutMs"); }
          catch (error) { return Promise.reject(error); }
          const abandoned = state.attached;
          if (abandoned && !closeOptions.force) return Promise.reject(new WorkspaceError("ATTACHED", "Stop the attached runtime before closing Workspace, or close({ force: true })"));
          if (state.clearing) return Promise.reject(new WorkspaceError("STORAGE_BUSY", "Wait for Workspace clear before closing"));
          // Close excludes new runtime attachments and file operations before its
          // asynchronous flush, so a concurrent start cannot lose live workers.
          state.closed = true;
          closing = (async () => {
            // A normal close has the kernel finalize its processes, flush and release
            // storage ownership before it is terminated, and rejects if that went
            // unacknowledged. A forced close cannot wait on a runtime that failed to
            // stop, so it only flushes before the hard kill below - and a kernel too
            // stuck to acknowledge even that must not hold the force path open.
            try {
              if (!abandoned) await h.close(closeOptions.timeoutMs === undefined ? {} : { timeoutMs: flushMs });
              else if ((await within(h.flush(), flushMs)).timedOut) throw new WorkspaceError("CLEANUP_FAILED", `Final flush was not acknowledged within ${flushMs}ms; recent writes may not be persisted`);
            }
            // Destroying the host ends every guest process and endpoint it owned.
            finally { off(); watches.clear(); h.destroy(); state.attached = false; opening = false; }
          })();
          if (!abandoned) return closing;
          // Forced: the store is flushed and released, but nothing proved the runtime
          // quiesced first. This caller is told once; later close() calls see closed.
          const unproven = new WorkspaceError("CLEANUP_FAILED", "Workspace force-closed while a runtime was attached; runtime cleanup unproven");
          return closing.then(() => { throw unproven; }, error => { throw new AggregateError([unproven, error], unproven.message); });
        },
      };
      workspaceInternals.set(workspace, state);
      options.onPersistenceChange?.(persistence);
      diagnostics.emit("open.ready");
      return workspace;
    } catch (error) { host?.destroy(); opening = false; diagnostics.failure(error); throw error; }
    finally { options.signal?.removeEventListener("abort", aborted); }
  }
}
