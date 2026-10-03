export type WorkspaceId = string;
export type DiagnosticEvent = { stage: string; elapsedMs: number; detail?: Record<string, unknown> };

/** One persistent origin store, currently mounted at /workspace. */
export interface WorkspaceStorage {
  readonly kind: "opfs";
  readonly distribution: Distribution;
}
export interface WorkspaceOpenOptions {
  /** Only "default" is supported until backend store namespaces exist. */
  id: WorkspaceId;
  storage: WorkspaceStorage;
  signal?: AbortSignal;
  /** How long to wait for another holder (e.g. a closing tab) to release the origin
   * store before open rejects with STORAGE_BUSY. Runtime default: 10000. */
  storageLockTimeoutMs?: number;
  onPersistenceChange?: (state: PersistenceState) => void;
  /** Best-effort structured startup milestones; contains no filesystem or guest output. */
  onDiagnostic?: (event: DiagnosticEvent) => void;
}
export interface WorkspaceCloseOptions {
  /** Close even while a runtime is attached: flush, destroy the host, detach. The close
   * still rejects with CLEANUP_FAILED, because runtime cleanup was never proven. */
  force?: boolean;
  /** Bound on the kernel's acknowledgement: of graceful shutdown (runtime default
   * 30000 when omitted), or of the final flush of a forced close (default 10000).
   * The host is destroyed either way. */
  timeoutMs?: number;
}
export interface WorkspaceFs {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<{ isDirectory: boolean; isFile: boolean; size: number }>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  watch(listener: (event: { paths: string[] }) => void): () => void;
}
export type PersistenceState =
  | { status: "opening" }
  | { status: "durable" }
  | { status: "ephemeral"; reason: string }
  | { status: "failed"; error: string };
export interface Distribution {
  readonly name: string;
  readonly version: string;
  /** Directory containing distribution.json and immutable assets. */
  readonly assetBaseUrl: string;
}
export type InstallTreeEntry =
  | { kind: "directory"; path: string; mode: number }
  | { kind: "symlink"; path: string; target: string }
  | { kind: "file"; path: string; mode: number; bytes: Uint8Array; sha256: string; verifyReadback?: boolean };
export type InstallTreeImageEntry =
  | { kind: "directory"; path: string; mode: number }
  | { kind: "symlink"; path: string; target: string }
  | { kind: "file"; path: string; mode: number; bytes: Uint8Array; logicalBytes: number; encoding: 0 | 1; sha256: string };
export interface TreeInstallResult { files: number; verifyMs: number; installMs: number; readbackMs: number }
export interface ToolContext {
  node(options: NodeLaunchOptions): Promise<Execution>;
  /** Runtime filesystem, including private installed tool payloads. */
  readFile(path: string): Promise<Uint8Array>;
  installFile(path: string, bytes: Uint8Array): Promise<void>;
  /** Verify then replace disposable roots in one filesystem-owner operation, before
   * launching readers. Not transactional on write failure. Caller retains bytes. */
  installTree(tree: { roots: string[]; entries: InstallTreeEntry[] }): Promise<TreeInstallResult>;
  /** Install checked preparation-built VFS bodies. The runtime consumes their backing buffers.
   * `bodiesVerified: true` states that the bodies are slices of one container whose digest
   * the caller already checked; the runtime then skips its per-file inflate + SHA-256. A
   * runtime that predates the flag ignores it and checks every file. */
  installTreeImage?(tree: { roots: string[]; entries: InstallTreeImageEntry[]; bodiesVerified?: boolean }): Promise<TreeInstallResult>;
}
export interface ToolDescriptor<TOptions, TResult> {
  readonly name: string;
  readonly version: string;
  bind(context: ToolContext): Promise<(options: TOptions) => Promise<TResult>>;
}
export interface NodeLaunchOptions {
  entry: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}
export interface Execution {
  /** Single-reader, byte-preserving channels. Drain concurrently. */
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exited: Promise<{ exitCode: number; signal: string | null; forced: boolean; cleanupError?: string }>;
  writeStdin(bytes: Uint8Array): void;
  closeStdin(): void;
  stop(): Promise<void>;
}
export interface PreviewAttachment { dispose(): void }
export interface PreviewOptions {
  /** Root-absolute same-origin paths (segment prefixes) sent natively to the host backend.
   * Example: ["/api"]. This is routing, never server authorization. */
  hostPaths?: readonly string[];
}
export interface Endpoint {
  readonly url: string;
  readonly port: number;
  readonly closed: Promise<{ reason: string }>;
  /** Disposal plus all endpoint HTTP read/cancel work, not admission closure. */
  readonly settled: Promise<void>;
  /** Streaming response; buffered upload (8 MiB). Manual redirect behavior. */
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /** Attach a mounted browser iframe using this endpoint's owning transport.
   * Safe to call from another package copy; no shared module identity is required. */
  attachPreview(iframe: HTMLIFrameElement, options?: PreviewOptions): PreviewAttachment;
  dispose(): void;
}
export type WorkspaceProcessDiagnostic = {
  pid: number;
  ppid: number;
  command: string;
  cwd: string;
  sinceOutputMs: number;
  sinceSyscallMs: number;
  syscalls: number;
  workerErrors: number;
  firstWorkerError?: string;
  booted: boolean;
  paused: boolean;
};
export type WorkspaceDiagnostics = {
  now: number;
  procs: WorkspaceProcessDiagnostic[];
  fetch: {
    inflight: number;
    queued: number;
    active: number;
    cachedEntries: number;
    cachedBytes: number;
    pinnedBodies: number;
  };
  listeners: number[];
  pendingHttp: number;
};
export type ErrorCode = "ENTRY_NOT_FOUND" | "LAUNCH_REJECTED" | "BACKEND_UNAVAILABLE"
  | "CLOSED" | "ATTACHED" | "STORAGE_BUSY" | "UNSUPPORTED_WORKSPACE" | "CLEANUP_FAILED"
  | "DISTRIBUTION_MISMATCH" | "OUTPUT_OVERFLOW" | "TOOL_FAILED";
export { WorkspaceError } from "@vivari/core/host";
