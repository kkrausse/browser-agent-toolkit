// Worker entry: one program per Worker. Loads the kernel and the guest, wires
// the guest's imports to the machine, runs `_start` to completion.

import { loadKernel } from "./kernel";
import { createMachine, ProcessExit } from "./machine";
import type { InitMessage, WorkerMessage } from "./protocol";
import { createRingReader } from "./ring";
import { createVfs } from "./vfs";
import { createWasi } from "./wasi";

const post = (message: WorkerMessage, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage(message, transfer);

async function run(init: InitMessage): Promise<void> {
  const [kernelModule, guestModule] = await Promise.all([
    WebAssembly.compileStreaming(fetch(init.kernelUrl)),
    WebAssembly.compileStreaming(fetch(init.guestUrl)),
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

  const wasi = createWasi({ args: init.args, env: init.env, machine, vfs });
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
  try {
    machine.flushOutput();
  } catch {
    // output flow control can only fail if the page is gone
  }
  post({ t: "exit", code, signal, error });
}

self.addEventListener("message", event => {
  const message = (event as MessageEvent<InitMessage>).data;
  if (message.t !== "init") return;
  run(message).catch(thrown => {
    console.error(thrown);
    post({ t: "exit", code: 127, error: thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown) });
  });
});
