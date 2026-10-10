// Page-side API: start a program in a Worker and talk to its terminal.
//
//   const program = startProgram({ guestUrl, kernelUrl, workerUrl, cols, rows,
//     onOutput: bytes => terminal.write(bytes), onExit: status => ... });
//   terminal.onData(data => program.write(data));
//   terminal.onResize(({ cols, rows }) => program.resize(cols, rows));

import { createNetBridge } from "./net";
import { openPersistStore, type PersistStore } from "./persist-store";
import {
  FRAME_CLIPBOARD, FRAME_INPUT, FRAME_RESIZE, FRAME_SIGNAL, H_OUT_ACK, HEADER_BYTES, type InitMessage, type WorkerMessage,
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
  /** Clipboard for programs that ask the host for it. Default: `navigator.clipboard`. */
  clipboard?: ClipboardBridge;
  /** Bytes for the terminal emulator (pty master output). */
  onOutput(data: Uint8Array): void;
  onExit?(status: ExitStatus): void;
}

export interface Program {
  /** Terminal input (pty master write): keystrokes, paste, mouse reports, replies to queries. */
  write(data: string | Uint8Array): void;
  /** Sets the window size; the program gets SIGWINCH if it changed. */
  resize(cols: number, rows: number, xpixel?: number, ypixel?: number): void;
  /** Sends a signal as if from `kill(1)`. */
  signal(signo: number): void;
  /** Stops the program immediately, whatever it is doing. */
  kill(): void;
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

export function startProgram(options: ProgramOptions): Program {
  if (!globalThis.crossOriginIsolated) {
    throw new Error("wasm-term needs a cross-origin isolated page (COOP: same-origin, COEP: require-corp) for SharedArrayBuffer");
  }
  const sab = createShared();
  const header = new Int32Array(sab, 0, HEADER_BYTES / 4);
  const ring = createRingWriter(sab);
  const net = createNetBridge(ring);
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

  function finish(status: ExitStatus): void {
    if (finished) return;
    finished = true;
    net.dispose();
    worker.terminate();
    options.onExit?.(status);
    resolveExit(status);
  }

  worker.addEventListener("message", event => {
    const message = (event as MessageEvent<WorkerMessage>).data;
    if (message.t === "out") {
      options.onOutput(message.data);
      Atomics.add(header, H_OUT_ACK, message.data.length);
      Atomics.notify(header, H_OUT_ACK);
    } else if (message.t === "drain") {
      ring.flush();
    } else if (message.t === "exit") {
      finish({ code: message.code, signal: message.signal, error: message.error });
    } else if (message.t === "log") {
      console.log(message.text);
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
    env: { ...DEFAULT_ENV, ...options.env },
    cols: options.cols,
    rows: options.rows,
    xpixel: options.xpixel ?? 0,
    ypixel: options.ypixel ?? 0,
    files: options.files,
    persist: options.persist && { roots: options.persist.roots, exclude: options.persist.exclude },
  };
  // Input, resizes and signals sent before the stored files have loaded wait in the ring.
  if (!store) worker.postMessage(init);
  else {
    store.load().catch(error => (console.warn("wasm-term: could not read persisted files", error), {})).then(stored => {
      init.files = { ...options.files, ...stored };
      if (!finished) worker.postMessage(init);
    });
  }

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
      finish({ code: 137, signal: 9 });
    },
    exited,
  };
}
