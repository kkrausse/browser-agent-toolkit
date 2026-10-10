// Worker entry for the prototype: wasm-term's own host/worker.ts with one
// addition, `installProcesses`. Everything else (kernel, machine, vfs, WASI)
// is imported unchanged from wasm-term/host.

import { loadKernel } from "../../../host/kernel";
import { createMachine, ProcessExit } from "../../../host/machine";
import type { InitMessage, WorkerMessage } from "../../../host/protocol";
import { createRingReader } from "../../../host/ring";
import { createVfs } from "../../../host/vfs";
import { createWasi } from "../../../host/wasi";
import { installProcesses } from "./proc";

export interface ProcInit {
  shModule: WebAssembly.Module;
  channels: SharedArrayBuffer[];
  spinUs: number;
}

const post = (message: WorkerMessage, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage(message, transfer);

async function run(init: InitMessage & { proc: ProcInit }): Promise<void> {
  const [kernelModule, guestModule] = await Promise.all([
    WebAssembly.compileStreaming(fetch(init.kernelUrl)),
    WebAssembly.compileStreaming(fetch(init.guestUrl)),
  ]);
  const kernel = await loadKernel(kernelModule);
  const pty = kernel.createPty(init.cols, init.rows);
  pty.setWinsize(init.cols, init.rows, init.xpixel, init.ypixel);
  pty.takeSignals();
  const machine = createMachine(pty, createRingReader(init.sab), post);
  const vfs = createVfs();
  if (init.env.HOME) vfs.mkdirp(init.env.HOME);
  // What `existsSync('/bin/bash')` and codex's shell detection (std::fs::metadata) look for.
  for (const stub of ["/bin/sh", "/bin/bash", "/usr/bin/env"]) vfs.writeFile(stub, new Uint8Array(0));

  installProcesses({ machine, vfs, shModule: init.proc.shModule, channels: init.proc.channels, spinUs: init.proc.spinUs });

  const wasi = createWasi({ args: init.args, env: init.env, machine, vfs });
  const instance = await WebAssembly.instantiate(guestModule, wasi.imports);
  const exports = instance.exports as { memory: WebAssembly.Memory; _start(): void };
  wasi.setMemory(exports.memory);
  let code = 0;
  let error: string | undefined;
  try {
    exports._start();
  } catch (thrown) {
    if (thrown instanceof ProcessExit) code = thrown.code;
    else {
      code = 134;
      error = thrown instanceof Error ? `${thrown.name}: ${thrown.message}\n${thrown.stack}` : String(thrown);
      console.error(thrown);
    }
  }
  try {
    machine.flushOutput();
  } catch {
    // the page is gone
  }
  post({ t: "exit", code, error });
}

self.addEventListener("message", event => {
  const message = (event as MessageEvent<InitMessage & { proc: ProcInit }>).data;
  if (message.t !== "init") return;
  run(message).catch(thrown => {
    console.error(thrown);
    post({ t: "exit", code: 127, error: String((thrown as Error)?.stack ?? thrown) });
  });
});
