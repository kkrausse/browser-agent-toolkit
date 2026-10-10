// What `/codex/terminal.js` (codex/terminal.ts, bundled by codex.ts) offers the editor panel. Types only and no
// imports, so that the app's typecheck and bundle stop here: the terminal, wasm-term and the kernel binding behind
// it are built on their own.

/** The page's binding to the toolkit kernel: `kernel` of the object the runtime's `bootRuntime` resolves with. */
export interface PageKernel {
  inst: { module: WebAssembly.Module; memory: WebAssembly.Memory }
  x: Record<string, (...args: number[]) => number>
  procList(): { pid: number; ppid: number; state: number }[]
  kill(pid: number, signal: number): void
}

export interface CodexOptions {
  container: HTMLElement
  /** URL of the directory codex.ts wrote, ending in `/`. */
  assets: string
  kernel: PageKernel
  /** The project: a directory of the kernel's filesystem, and codex's working directory. */
  workspace: string
  /** `openai`: the real service, sign in inside the TUI. `mock`: wasm-term's scripted model server, no sign-in (tests). */
  backend: 'openai' | 'mock' | 'mock-auth'
  /** `direct`: the browser's fetch straight to OpenAI. `tunnel`: codex's own TLS through `tcpRelay`. */
  net: 'direct' | 'tunnel'
  /** With `tunnel`: `wss://host/tcp` of a relay that only copies bytes (wasm-term/web/tcp-relay-main.ts). */
  tcpRelay?: string
  /** With a mock backend: where it is, when not `http://127.0.0.1:4791`. */
  mockUrl?: string
  fontSize?: number
  onLoad?(progress: { phase: 'download' | 'compile' | 'start'; loaded: number; total: number }): void
  onExit?(status: { code: number; signal?: number; error?: string }): void
  /** A request the browser refused, explained (an origin chatgpt.com does not accept, say). */
  onNotice?(text: string): void
}

export interface MountedCodex {
  /** Text of the visible screen, one string per row. */
  screen(): string[]
  write(data: string): void
  focus(): void
  /** Commands that have ended, oldest first. */
  procs: { command: string; status: number; signal: number; runMs: number }[]
  /** The program's requests: method, origin and path, status. No values. */
  requests: unknown[]
  /** A file of codex's own filesystem (not the workspace: read that through the editor's `fs`). */
  readFile(path: string): Promise<string | null>
  /** Stops codex and its commands and removes the terminal. Call before closing the editor. */
  dispose(): void
}

export interface CodexModule {
  mountCodex(options: CodexOptions): Promise<MountedCodex>
  /** Forgets the stored sign-in (`auth.json`) without contacting anyone. A running codex still holds it: dispose it first. */
  clearCodexCredentials(): Promise<void>
  hasCodexCredentials(): Promise<boolean>
  /** Forgets everything codex keeps in this browser (configuration, history, sessions, sign-in). */
  forgetCodexState(): Promise<void>
}
