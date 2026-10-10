// Worker entry: one program per Worker. Loads the kernel and the guest, wires
// the guest's imports to the machine, runs `_start` to completion.

import { loadKernel } from "./kernel";
import { createMachine, ProcessExit } from "./machine";
import type { FileRequest, InitMessage, WorkerMessage } from "./protocol";
import { createPersister } from "./persist";
import { createRingReader } from "./ring";
import { createVfs, serveFile, type Vfs } from "./vfs";
import { createWasi } from "./wasi";

const post = (message: WorkerMessage, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage(message, transfer);

/** WASM_TERM_TRACE=1: logs, about once a second, how often each import was called.
 * The quickest way to see what a guest is blocked on, or that an event loop is spinning.
 * Also logs every stretch of 100 ms or more between two host calls: the guest was
 * computing, and on its one thread that is time in which it read no input. */
function traceImports(imports: WebAssembly.Imports): void {
  let counts: Record<string, number> = {};
  let since = performance.now();
  const origin = since;
  let returned = since;
  let last = "start";
  for (const [moduleName, module] of Object.entries(imports)) {
    for (const [name, fn] of Object.entries(module)) {
      if (typeof fn !== "function") continue;
      (module as Record<string, unknown>)[name] = (...args: unknown[]) => {
        const key = moduleName === "wasm_term" ? `wasm_term.${name}` : name;
        counts[key] = (counts[key] ?? 0) + 1;
        const now = performance.now();
        if (now - returned >= 100) {
          post({ t: "log", text: `[wasm-term trace] guest computed for ${(now - returned).toFixed(0)}ms without a host call, from ${(returned - origin).toFixed(0)}ms after start (between ${last} and ${key})` });
        }
        last = key;
        if (now - since >= 1000) {
          const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(" ");
          post({ t: "log", text: `[wasm-term trace ${(now - since).toFixed(0)}ms] ${summary}` });
          counts = {};
          since = now;
        }
        try {
          return (fn as (...args: unknown[]) => unknown)(...args);
        } finally {
          returned = performance.now();
        }
      };
    }
  }
}

/** Compiles the guest while it downloads, reporting progress to the page (a
 * large module takes seconds over a real network, and the screen is empty until
 * it runs). The bytes are counted on a clone: the Response given to
 * `compileStreaming` must be the one `fetch` returned, or the browser neither
 * streams the compilation nor keeps the compiled code in its cache. */
async function compileGuest(url: string): Promise<WebAssembly.Module> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not load ${url}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  // Content-Length is the transfer size; a compressed response says how big the module is in its own header.
  const total = Number(response.headers.get("x-wasm-term-size") ?? (response.headers.get("content-encoding") ? 0 : response.headers.get("content-length")) ?? 0);
  const progress = (phase: "download" | "compile" | "start", loaded: number) => post({ t: "load", phase, loaded, total });
  const body = response.clone().body;
  let loaded = 0;
  const counted = (async () => {
    if (!body) return;
    const reader = body.getReader();
    let reported = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.length;
      const now = performance.now();
      if (now - reported >= 100) {
        reported = now;
        progress("download", loaded);
      }
    }
    progress("compile", loaded);
  })().catch(() => {});
  const module = await WebAssembly.compileStreaming(response);
  await counted;
  progress("start", loaded);
  return module;
}

/** `Program.readFile` / `listFiles` after the program has ended: the Worker is idle then and takes ordinary messages. */
function serveFilesAfterExit(vfs: Vfs): void {
  self.addEventListener("message", event => {
    const message = (event as MessageEvent<FileRequest>).data;
    if (message.t !== "file") return;
    const data = serveFile(vfs, message.op, message.path);
    post({ t: "file", id: message.id, data }, data ? [data.buffer] : []);
  });
}

async function run(init: InitMessage): Promise<void> {
  const [kernelModule, guestModule] = await Promise.all([
    WebAssembly.compileStreaming(fetch(init.kernelUrl)),
    compileGuest(init.guestUrl),
  ]);
  const kernel = await loadKernel(kernelModule);
  const pty = kernel.createPty(init.cols, init.rows);
  pty.setWinsize(init.cols, init.rows, init.xpixel, init.ypixel);
  pty.takeSignals(); // the initial size is not a resize

  const machine = createMachine(pty, createRingReader(init.sab), post);
  const vfs = createVfs();
  const encoder = new TextEncoder();
  for (const [path, contents] of Object.entries(init.files ?? {})) {
    vfs.writeFile(path, typeof contents === "string" ? encoder.encode(contents) : contents);
  }
  if (init.env.HOME) vfs.mkdirp(init.env.HOME);

  const persister = init.persist ? createPersister(vfs, init.persist, post) : null;
  machine.onFile = (id, op, path) => {
    const data = serveFile(vfs, op, path);
    post({ t: "file", id, data }, data ? [data.buffer] : []);
  };

  const wasi = createWasi({ args: init.args, env: init.env, machine, vfs, onFsChange: persister?.sync });
  if (init.env.WASM_TERM_TRACE) traceImports(wasi.imports);
  const instance = await WebAssembly.instantiate(guestModule, wasi.imports);
  const exports = instance.exports as { memory: WebAssembly.Memory; _start(): void };
  wasi.setMemory(exports.memory);

  let code = 0;
  let signal: number | undefined;
  let error: string | undefined;
  try {
    exports._start();
  } catch (thrown) {
    if (thrown instanceof ProcessExit) {
      code = thrown.code;
      signal = thrown.signal;
    } else {
      // A wasm trap (Rust panic=abort, stack overflow, ...) or a host bug.
      code = 134;
      error = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
      console.error(thrown);
    }
  }
  persister?.sync();
  try {
    machine.flushOutput();
  } catch {
    // output flow control can only fail if the page is gone
  }
  serveFilesAfterExit(vfs);
  post({ t: "exit", code, signal, error, lingers: true });
}

self.addEventListener("message", event => {
  const message = (event as MessageEvent<InitMessage>).data;
  if (message.t !== "init") return;
  run(message).catch(thrown => {
    console.error(thrown);
    post({ t: "exit", code: 127, error: thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown) });
  });
});
