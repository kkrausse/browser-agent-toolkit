/**
 * The whole contract between the toolkit and the in-browser runtime.
 *
 * `openEditor` (./browser) is written only against this file. The runtime ships a
 * module that exports `bootRuntime: BootRuntime`; the manifest names it
 * (`manifest.runtime.entry`, default `runtime/host.js` beside the manifest).
 * Development uses the fake in `./fake`, which backs the same interface with native
 * processes behind a dev server.
 *
 * Conventions for every member:
 * - Paths are absolute guest paths (`/workspace/src/home.tsx`).
 * - Promises reject with an `Error`; a missing path rejects with `error.code === 'ENOENT'`.
 * - After `close()` every call rejects and every stream ends.
 */

/** A program to start in the guest. `argv[0]` is resolved on PATH (`node`, `rg`, …). */
export interface Launch {
  argv: string[];
  /** Default `/`. */
  cwd?: string;
  /** The complete environment; nothing is inherited. */
  env?: Record<string, string>;
  /** Names of prepared program scripts (`manifest.programs[].name`) holding this
   * program's modules precompiled; the runtime may load them before the entry runs.
   * An optimisation: the launch must also work when the runtime ignores it. */
  programs?: string[];
}

export interface BootOptions {
  /** Absolute URL of `manifest.json`. The image, program scripts and runtime assets it
   * names are fetched relative to it. */
  manifestUrl: string;
  /** The manifest `openEditor` already fetched from `manifestUrl` (avoid a second fetch). */
  manifest: unknown;
  /** Aborting during boot rejects `bootRuntime`; afterwards it is equivalent to `close()`. */
  signal?: AbortSignal;
  /** Optional. The preview's service worker, for a page that is not served from `/` or whose
   * server cannot send `Service-Worker-Allowed` (a directory of static files): `url` is a
   * script at or above `scope` that runs the runtime's `sw.js` (`importScripts`), and
   * endpoints are then at `<scope>preview/<port>/`. Default: the runtime's `sw.js` with
   * scope `/preview/`. */
  serviceWorker?: { url: string; scope: string };
}

/** Resolves when the kernel is up, the image is mounted and the persisted overlay is
 * restored: the filesystem is readable and programs can be spawned. Rejects with
 * `error.code === 'STORAGE_BUSY'` when another tab holds this origin's workspace. */
export type BootRuntime = (options: BootOptions) => Promise<RuntimeHost>;

export interface FileStat { isFile: boolean; isDirectory: boolean; size: number; mtimeMs: number }

export interface RuntimeFs {
  readFile(path: string): Promise<Uint8Array>;
  /** Creates or replaces the file. The parent directory must exist. */
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  /** Follows symlinks. */
  stat(path: string): Promise<FileStat>;
  /** Entry names, unsorted, without `.` and `..`. */
  readdir(path: string): Promise<string[]>;
  /** Recursive; succeeds when the directory already exists. */
  mkdir(path: string): Promise<void>;
  /** Recursive for directories; succeeds when the path is already absent. */
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Recursive watch of a directory. Events may be coalesced; `paths` are absolute.
   * Returns the unsubscribe function. */
  watch(path: string, listener: (event: { paths: string[] }) => void): () => void;
}

export interface RuntimeProcess {
  /** Byte-preserving, single reader each. Unread output must not block the process
   * indefinitely: the runtime may drop the oldest bytes of an unread stream. */
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Resolves once, when the process is gone, however it ended. Never rejects. */
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  write(data: Uint8Array | string): void;
  /** End of input. OpenCode shuts down cleanly on it. */
  closeStdin(): void;
  /** Default `SIGTERM`. Killing an exited process is a no-op. */
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
}

export interface RuntimeEndpoint {
  /** Same-origin URL prefix that reaches the guest listener from a browser frame, ending
   * in `/` (`https://app.example/preview/5173/`; below the page's own directory when the
   * runtime was booted with a service-worker scope). The request path below the prefix is
   * passed to the guest together with the prefix, i.e. the guest server sees
   * `/preview/5173/...` and is configured with that base (see ./vite: `BROWSER_AGENT_BASE`
   * is the URL's path when it is not the default). WebSocket
   * upgrades and EventSource under the prefix reach the same listener. */
  readonly url: string;
  /** Direct request from the page to the guest listener, without the prefix: `path` is
   * what the guest server sees (`/api/health`). The response body streams (SSE works);
   * aborting `init.signal` closes the guest connection. Redirects are not followed. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Resolves when something in the guest listens on the port. Rejects when `signal`
   * aborts or the runtime closes. No timeout of its own. */
  ready(signal?: AbortSignal): Promise<void>;
}

export interface RuntimeHost {
  readonly fs: RuntimeFs;
  /** The origin a guest program uses to reach the page's own server, with the page's
   * scheme and port (`http://host.internal:3000`). Requests to it leave the guest as
   * same-origin page requests, cookies included. */
  readonly hostOrigin: string;
  /** Resolves when the process exists (pid assigned), not when it is listening. */
  spawn(launch: Launch): Promise<RuntimeProcess>;
  /** Cheap and synchronous; may be called before anything listens on `port`. Calling it
   * twice for one port returns equivalent endpoints. */
  endpoint(port: number): RuntimeEndpoint;
  /** Requests under `endpoint(port).url` whose path (below the prefix) starts with one
   * of these root-absolute prefixes go to the page's real server instead of the guest
   * (`['/api']`). Routing only. Replaces the previous list for that port. */
  setHostPaths(port: number, prefixes: readonly string[]): void;
  /** Optional. Root-absolute prefixes that the frame of `endpoint(port)` requests
   * (`{ '/api': 3001 }`: its app calls `/api/…` as if it were at the root of its own
   * server), each answered by the guest listener on the given port, which sees the path as
   * asked. For an app whose backend runs in the guest too. Replaces the previous routes. */
  setGuestPaths?(port: number, routes: Readonly<Record<string, number>>): void;
  /** Optional. Called once the preview and the agent are up (or have failed): the runtime may
   * now use the network for what it held back for them (the rest of the image download). */
  started?(): void;
  /** Resolves when every write made so far is durable. */
  flush(): Promise<void>;
  /** Kills every process, flushes, releases the workspace lock. Idempotent. */
  close(): Promise<void>;
}
