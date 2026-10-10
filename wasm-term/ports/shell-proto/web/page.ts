// Prototype page: starts the Rust test guest the way wasm-term's page starts
// any guest (host/index.ts `startProgram`, unchanged), and plays the part of
// the supervisor for shell Workers: it creates them (it is the one thread
// that is never blocked), hands each a channel, and replaces one that had to
// be terminated.
//
// startProgram creates the program's Worker itself and has no hook for extra
// init data, so the page wraps `Worker` for the duration of that one call:
// the `init` message gets a `proc` field, and messages of type `proc_*` from
// the Worker are handled here.

import { startProgram } from "../../../host/index";
import { H_WAKE } from "../../../host/protocol";
import { createChannel } from "../host/channel";
import type { ProcInit } from "../host/guest-worker";
import type { ProcPageMessage } from "../host/proc";
import type { ShellWorkerInit } from "../host/shell-worker";

const params = new URLSearchParams(location.search);
const SLOTS = Number(params.get("slots") ?? 4);
const WARM = Number(params.get("warm") ?? 2);
const spinUs = Number(params.get("spin") ?? 50);
const screen = document.getElementById("screen") as HTMLPreElement;
const decoder = new TextDecoder();
let text = "";
const state = { done: false, exit: null as unknown, output: "", result: null as unknown, workerStarts: [] as { slot: number; ms: number; why: string }[] };
(globalThis as unknown as { shellProto: typeof state }).shellProto = state;

const shModule = await WebAssembly.compileStreaming(fetch("/bat_sh.wasm"));
const channels = Array.from({ length: SLOTS }, createChannel);
const shellWorkers: (Worker | null)[] = channels.map(() => null);
let parentSab: SharedArrayBuffer | null = null;

function startShellWorker(slot: number, why: string): void {
  shellWorkers[slot]?.terminate();
  const began = performance.now();
  const worker = new Worker("/shell-worker.js", { type: "module", name: `shell:${slot}` });
  shellWorkers[slot] = worker;
  worker.postMessage({ t: "shell-init", channel: channels[slot]!, parent: parentSab!, wakeIndex: H_WAKE, module: shModule, spinUs } satisfies ShellWorkerInit);
  // Ready is a word in the channel; watch it only to report how long a Worker start takes.
  const ints = new Int32Array(channels[slot]!, 0, 1);
  const watch = () => {
    if (Atomics.load(ints, 0) === 1) state.workerStarts.push({ slot, ms: Math.round((performance.now() - began) * 10) / 10, why });
    else setTimeout(watch, 1);
  };
  watch();
}

const RealWorker = globalThis.Worker;
globalThis.Worker = class extends RealWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    this.addEventListener("message", event => {
      const message = (event as MessageEvent<ProcPageMessage>).data;
      if (message.t === "proc_need") startShellWorker(message.slot, "on demand");
      else if (message.t === "proc_replace") startShellWorker(message.slot, "replaced after kill");
    });
  }
  override postMessage(message: unknown, ...rest: unknown[]): void {
    const init = message as { t?: string; sab?: SharedArrayBuffer; proc?: ProcInit };
    if (init.t === "init") {
      parentSab = init.sab!;
      init.proc = { shModule, channels, spinUs };
      for (let slot = 0; slot < Math.min(WARM, SLOTS); slot++) startShellWorker(slot, "warm at start");
    }
    (super.postMessage as (...args: unknown[]) => void)(message, ...rest);
  }
} as typeof Worker;

const program = startProgram({
  guestUrl: "/guest.wasm",
  kernelUrl: "/kernel.wasm",
  workerUrl: "/guest-worker.js",
  args: ["shell-proto", ...params.getAll("arg")],
  env: Object.fromEntries(params.getAll("env").map(pair => pair.split(/=(.*)/s).slice(0, 2) as [string, string])),
  cols: 120,
  rows: 40,
  onOutput(data) {
    text += decoder.decode(data, { stream: true });
    state.output = text;
    screen.textContent = text;
    const marker = text.lastIndexOf("RESULT ");
    if (marker >= 0 && text.indexOf("\n", marker) > 0) {
      try {
        state.result = JSON.parse(text.slice(marker + 7, text.indexOf("\n", marker)));
      } catch {
        // partial line
      }
    }
  },
  onExit(status) {
    state.exit = status;
    state.done = true;
    screen.textContent = `${text}\n[exit ${JSON.stringify(status)}]`;
  },
});
globalThis.Worker = RealWorker;
void program;
