import { Host } from "./host.js";
import { diagnosticReporter } from "./diagnostics.js";
import { WorkspaceError, type Distribution, type PersistenceState, type WorkspaceFs, type WorkspaceOpenOptions, type WorkspaceStorage } from "./types.js";

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
  close(): Promise<void>;
}
export const workspaceInternals = new WeakMap<Workspace, { host: Host; distribution: Distribution; attached: boolean; closed: boolean }>();
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
      const state = { host: h, distribution: options.storage.distribution, attached: false, closed: false };
      let closing: Promise<void> | undefined;
      const check = () => { if (state.closed) throw new WorkspaceError("CLOSED", "Workspace closed"); };
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
        close() {
          if (closing) return closing;
          if (state.attached) return Promise.reject(new WorkspaceError("ATTACHED", "Stop the attached runtime before closing Workspace"));
          // Close excludes new runtime attachments and file operations before its
          // asynchronous flush, so a concurrent start cannot lose live workers.
          state.closed = true;
          return closing = (async () => {
            try { await h.flush(); }
            finally { off(); watches.clear(); h.destroy(); opening = false; }
          })();
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
