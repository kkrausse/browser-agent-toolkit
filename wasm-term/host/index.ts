// Page-side API: start a program in a Worker and talk to its terminal.
//
//   const program = startProgram({ guestUrl, kernelUrl, workerUrl, cols, rows,
//     onOutput: bytes => terminal.write(bytes), onExit: status => ... });
//   terminal.onData(data => program.write(data));
//   terminal.onResize(({ cols, rows }) => program.resize(cols, rows));

import { createNetBridge } from "./net";
import { type PageFetchOptions, servePageFetch } from "./page-fetch";
import { openPersistStore, type PersistStore } from "./persist-store";
import {
  FILE_LIST, FILE_READ, FRAME_CLIPBOARD, FRAME_FILE, FRAME_INPUT, FRAME_PROC, FRAME_RESIZE, FRAME_SIGNAL, H_OUT_ACK, H_OUT_WAITING, H_WAKE, HEADER_BYTES,
  type FileRequest, type InitMessage, type ShellWorkerInit, type WorkerMessage,
} from "./protocol";
import { createRingWriter, createShared } from "./ring";

export interface ExitStatus {
  code: number;
  /** Set when the program was terminated by a signal's default action. */
  signal?: number;
  /** Set when the program trapped or failed to start. */
  error?: string;
}

/** The system clipboard as the page offers it to programs. */
export interface ClipboardBridge {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

export interface PersistOptions {
  /** Storage key: programs with different namespaces do not see each other's files. */
  namespace: string;
  /** Absolute directories whose files survive a reload. */
  roots: string[];
  /** Paths containing any of these substrings are not stored. */
  exclude?: string[];
}

/** A shell for the program's `proc_*` calls (wasm guests): `bat_sh.wasm`, this repository's crates/bat-sh, see `proc.ts`. */
export interface ShellOptions {
  /** `bat_sh.wasm`. */
  moduleUrl: string;
  /** The bundled `host/shell-worker.ts`. */
  workerUrl: string;
  /** Default: `worker`, or `inline` on a machine with at most two cores. */
  mode?: "worker" | "inline";
  /** Commands that run at once (shell Workers); default 4. */
  slots?: number;
  /** Microseconds each side of a channel spins before it sleeps; default 50. */
  spinUs?: number;
}

/** One finished child process. */
export interface ProcStat {
  command: string;
  status: number;
  signal: number;
  /** Host calls (file operations, writes) the shell made. */
  calls: number;
  /** From `proc_spawn` until a shell picked the command up, and from then until it ended, in ms. */
  queueMs: number;
  runMs: number;
}

export interface ProgramOptions {
  /** A wasm32-wasip1 module (with `host/worker.ts`) or a JavaScript guest module (with `host/js-worker.ts`). */
  guestUrl: string;
  kernelUrl: string;
  /** The Worker entry that matches the guest kind: the bundled `host/worker.ts` or `host/js-worker.ts`. */
  workerUrl: string;
  args?: string[];
  env?: Record<string, string>;
  cols: number;
  rows: number;
  xpixel?: number;
  ypixel?: number;
  files?: Record<string, Uint8Array | string>;
  /** Keeps the named directories in IndexedDB across reloads. Stored files win over `files`. */
  persist?: PersistOptions;
  /** Gives the program a shell to run commands in (`proc_*`). */
  shell?: ShellOptions;
  /** Where `tcp_connect` goes: the URL (or a path on this origin) of a TCP relay endpoint, `/proxy/tcp` of web/server.ts
   * (docs/abi.md 3.3, "TCP"). Absent: `tcp_connect` fails. */
  tcpRelay?: string;
  /** Clipboard for programs that ask the host for it. Default: `navigator.clipboard`. */
  clipboard?: ClipboardBridge;
  /** JavaScript guests: `fetch` of URLs under these prefixes is answered by the page (page-fetch.ts), e.g. by a server that runs in this tab. */
  pageFetch?: PageFetchOptions;
  /** Bytes for the terminal emulator (pty master output). */
  onOutput(data: Uint8Array): void;
  onExit?(status: ExitStatus): void;
  /** A wasm guest's start: module bytes received so far (`total` 0 = unknown), then compiling, then running. */
  onLoad?(progress: LoadProgress): void;
}

export interface LoadProgress {
  phase: "download" | "compile" | "start";
  loaded: number;
  total: number;
}

export interface Program {
  /** Terminal input (pty master write): keystrokes, paste, mouse reports, replies to queries. */
  write(data: string | Uint8Array): void;
  /** Sets the window size; the program gets SIGWINCH if it changed. */
  resize(cols: number, rows: number, xpixel?: number, ypixel?: number): void;
  /** Sends a signal as if from `kill(1)`. */
  signal(signo: number): void;
  /** Stops the program immediately, whatever it is doing. After a wasm guest has exited by itself, releases its files. */
  kill(): void;
  /** A file out of the program's filesystem, for debugging (logs, configuration): null when there is no such file.
   * Answered the next time the program makes a host call; still answered after a wasm guest has exited. */
  readFile(path: string): Promise<Uint8Array | null>;
  /** Every regular file below a directory of the program's filesystem. */
  listFiles(directory: string): Promise<{ path: string; size: number }[]>;
  /** The child processes that have ended, oldest first (the last 500), and when each shell Worker was started and why. */
  procs: ProcStat[];
  shellWorkers: { slot: number; why: "need" | "replace"; at: number }[];
  exited: Promise<ExitStatus>;
}

export const DEFAULT_ENV: Record<string, string> = {
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  HOME: "/home/user",
  USER: "user",
  PWD: "/home/user",
  LANG: "C.UTF-8",
};

/** The browser's time zone, which nothing inside the machine can discover: WASI
 * has no zone interface and there is no zone database in the filesystem.
 * `TZ` is the IANA name; `WASM_TERM_UTC_OFFSET_MINUTES` is the offset east of
 * UTC when the program starts (a program running across a DST change keeps it). */
export function timeZoneEnv(now = new Date()): Record<string, string> {
  const env: Record<string, string> = { WASM_TERM_UTC_OFFSET_MINUTES: String(-now.getTimezoneOffset()) };
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) env.TZ = zone;
  } catch {
    // no Intl: the offset alone
  }
  return env;
}

export function startProgram(options: ProgramOptions): Program {
  if (!globalThis.crossOriginIsolated) {
    throw new Error("wasm-term needs a cross-origin isolated page (COOP: same-origin, COEP: require-corp) for SharedArrayBuffer");
  }
  const sab = createShared();
  const header = new Int32Array(sab, 0, HEADER_BYTES / 4);
  const ring = createRingWriter(sab);
  const net = createNetBridge(ring, { tcpRelay: options.tcpRelay });
  const encoder = new TextEncoder();
  const worker = new Worker(options.workerUrl, { type: "module", name: `wasm-term:${options.guestUrl}` });

  const store: PersistStore | null = options.persist ? openPersistStore(options.persist.namespace) : null;
  const clipboard: ClipboardBridge = options.clipboard ?? {
    readText: () => navigator.clipboard.readText(),
    writeText: text => navigator.clipboard.writeText(text),
  };
  function clipboardReply(id: number, ok: boolean, text: string): void {
    const body = encoder.encode(text);
    const payload = new Uint8Array(8 + body.length);
    new DataView(payload.buffer).setUint32(0, id, true);
    new DataView(payload.buffer).setUint32(4, ok ? 1 : 0, true);
    payload.set(body, 8);
    ring.send(FRAME_CLIPBOARD, payload);
  }

  let finished = false;
  let resolveExit!: (status: ExitStatus) => void;
  const exited = new Promise<ExitStatus>(resolve => (resolveExit = resolve));

  /** After its program has ended a wasm guest's Worker stays, idle, to answer file requests. */
  let lingering = false;
  let fileRequests = 0;
  const fileWaiters = new Map<number, (data: Uint8Array | null) => void>();
  // Shell Workers, by channel slot. Created here because this thread is the only one that is never blocked.
  const shells = new Map<number, Worker>();
  const procs: ProcStat[] = [];
  const shellWorkers: Program["shellWorkers"] = [];
  let shellModule: WebAssembly.Module | undefined;
  function startShell(slot: number, channel: SharedArrayBuffer, why: "need" | "replace"): void {
    shells.get(slot)?.terminate();
    shells.delete(slot);
    const report = (ok: boolean) => ring.send(FRAME_PROC, new Uint8Array(new Uint32Array([slot, ok ? 1 : 0]).buffer));
    if (finished || !options.shell || !shellModule) return report(false);
    try {
      const shell = new Worker(options.shell.workerUrl, { type: "module", name: `wasm-term:shell:${slot}` });
      shell.addEventListener("error", event => {
        console.warn("wasm-term: shell worker failed", event.message);
        if (shells.get(slot) === shell) report(false);
      });
      shell.postMessage({ t: "shell-init", channel, parent: sab, module: shellModule, spinUs: options.shell.spinUs ?? 50 } satisfies ShellWorkerInit);
      shells.set(slot, shell);
      shellWorkers.push({ slot, why, at: performance.now() });
    } catch (error) {
      console.warn("wasm-term: could not start a shell worker", error);
      report(false);
    }
  }
  function dropShells(): void {
    for (const shell of shells.values()) shell.terminate();
    shells.clear();
  }

  function dropWorker(): void {
    lingering = false;
    worker.terminate();
    for (const resolve of fileWaiters.values()) resolve(null);
    fileWaiters.clear();
  }

  function finish(status: ExitStatus, lingers = false): void {
    if (finished) return;
    finished = true;
    net.dispose();
    stopPageFetch?.();
    dropShells();
    if (lingers) lingering = true;
    else dropWorker();
    options.onExit?.(status);
    resolveExit(status);
  }

  function requestFile(op: number, path: string): Promise<Uint8Array | null> {
    if (finished && !lingering) return Promise.resolve(null);
    const id = ++fileRequests;
    const answer = new Promise<Uint8Array | null>(resolve => fileWaiters.set(id, resolve));
    if (lingering) worker.postMessage({ t: "file", id, op, path } satisfies FileRequest);
    else {
      const name = encoder.encode(path);
      const payload = new Uint8Array(8 + name.length);
      new DataView(payload.buffer).setUint32(0, id, true);
      new DataView(payload.buffer).setUint32(4, op, true);
      payload.set(name, 8);
      ring.send(FRAME_FILE, payload);
    }
    return answer;
  }

  worker.addEventListener("message", event => {
    const message = (event as MessageEvent<WorkerMessage>).data;
    if (message.t === "out") {
      options.onOutput(message.data);
      Atomics.add(header, H_OUT_ACK, message.data.length);
      // The Worker waits for acks on its wake counter (it also answers its shell Workers there).
      if (Atomics.load(header, H_OUT_WAITING) === 1) {
        Atomics.add(header, H_WAKE, 1);
        Atomics.notify(header, H_WAKE);
      }
    } else if (message.t === "drain") {
      ring.flush();
    } else if (message.t === "exit") {
      finish({ code: message.code, signal: message.signal, error: message.error }, message.lingers === true);
    } else if (message.t === "file") {
      fileWaiters.get(message.id)?.(message.data);
      fileWaiters.delete(message.id);
    } else if (message.t === "load") {
      options.onLoad?.({ phase: message.phase, loaded: message.loaded, total: message.total });
    } else if (message.t === "log") {
      console.log(message.text);
    } else if (message.t === "proc_need" || message.t === "proc_replace") {
      startShell(message.slot, message.channel, message.t === "proc_need" ? "need" : "replace");
    } else if (message.t === "proc_stat") {
      const { t: _, ...stat } = message;
      procs.push(stat);
      if (procs.length > 500) procs.shift();
    } else if (message.t === "persist") {
      store?.save(message.path, message.data);
    } else if (message.t === "clipboard_write") {
      clipboard.writeText(message.text).catch(error => console.warn("wasm-term: clipboard write refused", error));
    } else if (message.t === "clipboard_read") {
      clipboard.readText().then(
        text => clipboardReply(message.id, true, text),
        error => clipboardReply(message.id, false, String((error as Error)?.message ?? error)),
      );
    } else {
      net.handle(message);
    }
  });
  worker.addEventListener("error", event => finish({ code: 127, error: event.message || "worker failed to load" }));

  const init: InitMessage = {
    t: "init",
    sab,
    kernelUrl: new URL(options.kernelUrl, location.href).href,
    guestUrl: new URL(options.guestUrl, location.href).href,
    args: options.args ?? ["program"],
    env: { ...DEFAULT_ENV, ...timeZoneEnv(), ...options.env },
    cols: options.cols,
    rows: options.rows,
    xpixel: options.xpixel ?? 0,
    ypixel: options.ypixel ?? 0,
    files: options.files,
    persist: options.persist && { roots: options.persist.roots, exclude: options.persist.exclude },
  };
  let stopPageFetch: (() => void) | undefined;
  const transfer: Transferable[] = [];
  if (options.pageFetch) {
    const channel = new MessageChannel();
    stopPageFetch = servePageFetch(channel.port1, options.pageFetch);
    init.pageFetch = { port: channel.port2, prefixes: options.pageFetch.prefixes };
    transfer.push(channel.port2);
  }
  // Input, resizes and signals sent before the stored files and the shell module have loaded wait in the ring.
  const stored = store
    ? store.load().catch(error => (console.warn("wasm-term: could not read persisted files", error), {} as Record<string, Uint8Array>))
    : Promise.resolve(undefined);
  const shell = options.shell
    ? fetch(new URL(options.shell.moduleUrl, location.href))
      .then(async response => {
        if (!response.ok) throw new Error(`${options.shell!.moduleUrl}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
        return WebAssembly.compile(await response.arrayBuffer());
      })
      .catch(error => (console.warn("wasm-term: no shell", error), undefined))
    : Promise.resolve(undefined);
  Promise.all([stored, shell]).then(([files, module]) => {
    if (files) init.files = { ...options.files, ...files };
    if (module && options.shell) {
      shellModule = module;
      const cores = globalThis.navigator?.hardwareConcurrency ?? 4;
      init.proc = {
        module,
        mode: options.shell.mode ?? (cores <= 2 ? "inline" : "worker"),
        slots: options.shell.slots ?? 4,
        prewarm: 1,
        spinUs: options.shell.spinUs ?? 50,
      };
    }
    if (!finished) worker.postMessage(init, transfer);
  });

  return {
    write(data) {
      if (finished) return;
      ring.send(FRAME_INPUT, typeof data === "string" ? encoder.encode(data) : data);
    },
    resize(cols, rows, xpixel = 0, ypixel = 0) {
      if (finished) return;
      ring.send(FRAME_RESIZE, new Uint8Array(new Uint16Array([cols, rows, xpixel, ypixel]).buffer));
    },
    signal(signo) {
      if (finished) return;
      ring.send(FRAME_SIGNAL, new Uint8Array(new Uint32Array([signo]).buffer));
    },
    kill() {
      if (finished) dropWorker();
      else finish({ code: 137, signal: 9 });
    },
    readFile: path => requestFile(FILE_READ, path),
    async listFiles(directory) {
      const data = await requestFile(FILE_LIST, directory);
      return data ? (JSON.parse(new TextDecoder().decode(data)) as { path: string; size: number }[]) : [];
    },
    procs,
    shellWorkers,
    exited,
  };
}
