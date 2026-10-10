// Runs a JavaScript program on the machine, the way worker.ts runs a wasm
// guest: same InitMessage in, same WorkerMessages out, same inbound ring. The
// difference is that a JavaScript program cannot block: it returns to the
// Worker's event loop, so instead of blocking syscalls there is an async pump
// that wakes on the ring's wake counter and feeds process.stdin.
//
// A guest is an ES module exporting
//
//   export async function main(context: JsGuestContext): Promise<number | void>
//
// It is imported only after the node shim is in place (globalThis.process,
// Buffer, node-style timers, the fs behind `node:fs`), because bundles read
// those while their modules are evaluated. The program ends when `main`
// returns (exit code = the returned number, default 0), when it calls
// process.exit, or when a signal's default action kills it.

import { loadKernel } from "../kernel";
import { createMachine, type Machine, ProcessExit } from "../machine";
import { createPersister } from "../persist";
import { H_WAKE, type InitMessage, type WorkerMessage } from "../protocol";
import { createRingReader } from "../ring";
import { createVfs, serveFile, type Vfs } from "../vfs";
import { createNodeFs, type NodeFs } from "./fs";
import { installNodeGlobals } from "./globals";
import { createNodeProcess } from "./process";
import { installNodeTimers } from "./timers";
import { Buffer } from "node:buffer";

export interface JsGuestContext {
  machine: Machine;
  vfs: Vfs;
  fs: NodeFs;
  /** Also `globalThis.process`. */
  process: any;
  args: string[];
  env: Record<string, string>;
  /** The guest module's own URL: resolve the program's other assets against it. */
  guestUrl: string;
  /** A line for the page's console. */
  log(text: string): void;
  /** The system clipboard, through the page. `readText` rejects when the browser refuses. */
  clipboard: {
    readText(): Promise<string>;
    writeText(text: string): Promise<void>;
  };
}

export interface JsGuestModule {
  main(context: JsGuestContext): Promise<number | void> | number | void;
}

type Post = (message: WorkerMessage, transfer?: Transferable[]) => void;

export async function runJsGuest(init: InitMessage, post: Post): Promise<void> {
  const kernel = await loadKernel(await WebAssembly.compileStreaming(fetch(init.kernelUrl)));
  const pty = kernel.createPty(init.cols, init.rows);
  pty.setWinsize(init.cols, init.rows, init.xpixel, init.ypixel);
  pty.takeSignals(); // the initial size is not a resize

  const machine = createMachine(pty, createRingReader(init.sab), (message, transfer) => post(message, transfer));
  const vfs = createVfs();
  const encoder = new TextEncoder();
  for (const [path, contents] of Object.entries(init.files ?? {})) {
    vfs.writeFile(path, typeof contents === "string" ? encoder.encode(contents) : contents);
  }
  if (init.env.HOME) vfs.mkdirp(init.env.HOME);
  const persister = init.persist ? createPersister(vfs, init.persist, post) : null;
  // Program.readFile / listFiles from the page (while the program runs; its Worker goes away at exit).
  machine.onFile = (id, op, path) => {
    const data = serveFile(vfs, op, path);
    post({ t: "file", id, data }, data ? [data.buffer] : []);
  };

  let exited = false;
  function exit(code: number, signal?: number, error?: string): void {
    if (exited) return;
    exited = true;
    persister?.sync();
    try {
      machine.flushOutput();
    } catch {
      // output flow control can only fail if the page is gone
    }
    post({ t: "exit", code, signal, error });
  }

  const node = createNodeProcess(machine, { env: { ...init.env }, argv: init.args, exit: code => exit(code) });
  const fs = createNodeFs(vfs, { cwd: () => node.process.cwd(), changed: () => persister?.sync() });
  const globals = globalThis as Record<string, any>;
  globals.process = node.process;
  globals.global = globalThis;
  globals.Buffer ??= Buffer;
  // Bun's browser polyfill of node:util references this binding without
  // defining it (ReferenceError at module evaluation); a global satisfies it.
  globals.kCustomPromisifiedSymbol ??= Symbol.for("nodejs.util.promisify.custom");
  installNodeTimers();
  installNodeGlobals({ fs, process: node.process });

  let nextClipboardId = 1;
  const clipboardReads = new Map<number, { resolve(text: string): void; reject(error: Error): void }>();
  machine.onClipboard = (id, ok, text) => {
    const waiting = clipboardReads.get(id);
    clipboardReads.delete(id);
    if (ok) waiting?.resolve(text);
    else waiting?.reject(new Error(text || "clipboard read refused"));
  };

  /** Everything the page sent: line discipline, winsize, signals, then stdin data and signal events. */
  function pump(): void {
    if (exited) return;
    try {
      machine.pump();
      node.dispatch();
    } catch (thrown) {
      if (!(thrown instanceof ProcessExit)) throw thrown;
      node.process.emit("exit", thrown.code);
      exit(thrown.code, thrown.signal);
    }
  }
  async function pumpForever(): Promise<void> {
    const waitAsync = (Atomics as unknown as {
      waitAsync?(array: Int32Array, index: number, value: number, timeout: number): { async: boolean; value: Promise<string> | string };
    }).waitAsync;
    const header = machine.ring.header;
    while (!exited) {
      const seen = Atomics.load(header, H_WAKE);
      pump();
      if (waitAsync) {
        const waiter = waitAsync(header, H_WAKE, seen, 1000);
        if (waiter.async) await waiter.value;
      } else {
        // Before Atomics.waitAsync (Safari < 16.4, Firefox < 145): poll.
        await new Promise(resolve => setTimeout(resolve, 8));
      }
    }
  }
  void pumpForever().catch(thrown => exit(134, undefined, String(thrown?.stack ?? thrown)));

  const context: JsGuestContext = {
    machine, vfs, fs,
    process: node.process,
    args: init.args,
    env: node.process.env,
    guestUrl: init.guestUrl,
    log: text => post({ t: "log", text }),
    clipboard: {
      readText: () => new Promise((resolve, reject) => {
        const id = nextClipboardId++;
        clipboardReads.set(id, { resolve, reject });
        post({ t: "clipboard_read", id });
      }),
      async writeText(text) {
        post({ t: "clipboard_write", text });
      },
    },
  };

  try {
    const guest = (await import(/* @vite-ignore */ init.guestUrl)) as JsGuestModule;
    if (typeof guest.main !== "function") throw new Error(`${init.guestUrl} does not export main(context)`);
    const code = await guest.main(context);
    node.process.exit(typeof code === "number" ? code : undefined);
  } catch (thrown) {
    if (exited) return;
    const text = thrown instanceof Error ? thrown.stack ?? `${thrown.name}: ${thrown.message}` : String(thrown);
    console.error(thrown);
    node.process.stderr.write(`\r\n${init.args[0] ?? "program"}: ${text.replaceAll("\n", "\r\n")}\r\n`);
    exit(1, undefined, text);
  }
}
