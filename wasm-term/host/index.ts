// Page-side API: start a program in a Worker and talk to its terminal.
//
//   const program = startProgram({ guestUrl, kernelUrl, workerUrl, cols, rows,
//     onOutput: bytes => terminal.write(bytes), onExit: status => ... });
//   terminal.onData(data => program.write(data));
//   terminal.onResize(({ cols, rows }) => program.resize(cols, rows));

import { createNetBridge } from "./net";
import {
  FRAME_INPUT, FRAME_RESIZE, FRAME_SIGNAL, H_OUT_ACK, HEADER_BYTES, type InitMessage, type WorkerMessage,
} from "./protocol";
import { createRingWriter, createShared } from "./ring";

export interface ExitStatus {
  code: number;
  /** Set when the program was terminated by a signal's default action. */
  signal?: number;
  /** Set when the program trapped or failed to start. */
  error?: string;
}

export interface ProgramOptions {
  guestUrl: string;
  kernelUrl: string;
  workerUrl: string;
  args?: string[];
  env?: Record<string, string>;
  cols: number;
  rows: number;
  xpixel?: number;
  ypixel?: number;
  files?: Record<string, Uint8Array | string>;
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
  };
  worker.postMessage(init);

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
