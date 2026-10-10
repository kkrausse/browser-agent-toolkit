// Processes for a wasm-term guest, prototype. The guest asks for a command to
// be run and gets ONE pollable descriptor that delivers the child's stdout,
// stderr and exit status as framed events, in order, as they happen.
//
// To try that without editing wasm-term's host, the descriptor is borrowed
// from the HTTP ones the ABI already has (docs/abi.md 3.3): the guest calls
// `http_open("SPAWN", "proc:spawn?mode=worker", body = request)`, this module
// sees the `http_open` message the host would have sent to the page, keeps it,
// and fills the descriptor's queue itself. Reading, poll_oneoff readiness,
// O_NONBLOCK and close then all work through wasm-term's unchanged code,
// which is exactly what the proposed `proc_*` imports need from the host
// (SHELL-DESIGN.md has those; this file is their behaviour).
//
// Body of the descriptor: frames of `u8 kind, u32 length (LE), payload`.
//   1 stdout bytes   2 stderr bytes   3 exit: text "status=N signal=N queue_us=N run_us=N calls=N"
//
// Two ways to run the shell, same frames either way:
//   mode=inline  bat_sh.wasm runs to completion inside the spawn call, in this
//                Worker, on the vfs directly. Nothing else runs meanwhile.
//   mode=worker  a shell Worker runs it; its host calls arrive over channel.ts
//                and are served here whenever the guest is inside a host call.

import type { HttpHandle, Machine } from "../../../host/machine";
import { H_READ, H_WAKE, H_WRITE, type WorkerMessage } from "../../../host/protocol";
import type { Vfs } from "../../../host/vfs";
import { type ChannelServer, createChannelServer, DEFAULT_SPIN_US } from "./channel";
import { createShHost, OP, type Reply, type ShHost } from "./sh-host";
import { createShRunner, ShAbort } from "./sh-wasm";

const FRAME_STDOUT = 1;
const FRAME_STDERR = 2;
const FRAME_EXIT = 3;
/** Output queued for the guest beyond which a shell Worker's writes are left unanswered. */
const OUT_WINDOW = 1 << 20;
/** A killed shell Worker that has not ended by itself after this long is terminated by the page. */
const HARD_KILL_MS = 250;

export interface ProcOptions {
  machine: Machine;
  vfs: Vfs;
  shModule: WebAssembly.Module;
  channels: SharedArrayBuffer[];
  spinUs?: number;
  /** Called after a run that may have changed files (the persistence hook wasi.ts calls on close). */
  onFsChange?(): void;
}

interface Proc {
  handle: HttpHandle;
  fd: number;
  host: ShHost;
  slot: number;
  queued: number;
  spawnedAt: number;
  startedAt: number;
  killAt: number;
  done: boolean;
}

/** Messages this module adds to the Worker -> page traffic. */
export type ProcPageMessage =
  | { t: "proc_need"; slot: number } // no shell Worker on this channel yet: make one
  | { t: "proc_replace"; slot: number }; // terminate the shell Worker on this channel and make a new one

export function installProcesses({ machine, vfs, shModule, channels, spinUs = DEFAULT_SPIN_US, onFsChange }: ProcOptions): void {
  const encoder = new TextEncoder();
  const servers: ChannelServer[] = channels.map(createChannelServer);
  const slots: (Proc | null)[] = channels.map(() => null);
  const requested = channels.map(() => false);
  const byFd = new Map<number, Proc>();
  const waiting: { proc: Proc; job: Uint8Array }[] = [];
  const postToPage = machine.post.bind(machine);

  function frame(proc: Proc, kind: number, payload: Uint8Array): void {
    const chunk = new Uint8Array(5 + payload.length);
    chunk[0] = kind;
    new DataView(chunk.buffer).setUint32(1, payload.length, true);
    chunk.set(payload, 5);
    proc.handle.chunks.push(chunk);
    proc.queued += chunk.length;
  }

  function finish(proc: Proc, status: number, signal: number): void {
    if (proc.done) return;
    proc.done = true;
    const now = performance.now();
    const queueUs = Math.round(((proc.startedAt || now) - proc.spawnedAt) * 1000);
    const runUs = Math.round((now - (proc.startedAt || now)) * 1000);
    frame(proc, FRAME_EXIT, encoder.encode(`status=${status} signal=${signal} queue_us=${queueUs} run_us=${runUs} calls=${proc.host.calls()}`));
    proc.handle.ended = true;
    if (proc.slot >= 0) slots[proc.slot] = null;
    onFsChange?.();
  }

  function decodeJob(body: Uint8Array): { argv: string[]; env: string[]; cwd: string } {
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const decoder = new TextDecoder();
    const argc = view.getUint32(0, true);
    const envc = view.getUint32(4, true);
    let at = 8;
    const text = () => {
      const length = view.getUint32(at, true);
      const value = decoder.decode(body.subarray(at + 4, at + 4 + length));
      at += 4 + length;
      return value;
    };
    const cwd = text();
    return { cwd, argv: Array.from({ length: argc }, text), env: Array.from({ length: envc }, text) };
  }

  // One shell instance for inline runs, as bat-rust's own execSync keeps one per process.
  let inlineProc: Proc | null = null;
  let inlineDeadline = Infinity;
  const inlineCheckpoint = () => {
    if (performance.now() > inlineDeadline) throw new ShAbort(15, true);
  };
  const inlineSleeper = new Int32Array(new SharedArrayBuffer(4));
  const inlineRunner = createShRunner({
    module: shModule,
    call: (op, n1, n2, s1, s2, data) => inlineProc!.host.call(op, n1, n2, s1, s2, data),
    checkpoint: inlineCheckpoint,
    sleep(ms) {
      const until = performance.now() + ms;
      for (;;) {
        inlineCheckpoint();
        const left = Math.min(until, inlineDeadline + 1) - performance.now();
        if (performance.now() >= until) return;
        Atomics.wait(inlineSleeper, 0, 0, Math.max(1, left));
      }
    },
  });

  function runInline(proc: Proc, body: Uint8Array, timeoutMs: number): void {
    inlineProc = proc;
    inlineDeadline = timeoutMs > 0 ? performance.now() + timeoutMs : Infinity;
    proc.startedAt = performance.now();
    try {
      finish(proc, inlineRunner.run(decodeJob(body)), 0);
    } catch (thrown) {
      if (thrown instanceof ShAbort) finish(proc, thrown.timedOut ? 124 : 128 + thrown.signal, thrown.signal);
      else {
        frame(proc, FRAME_STDERR, encoder.encode(`sh: internal error: ${(thrown as Error)?.message ?? thrown}\n`));
        finish(proc, 134, 0);
      }
    }
  }

  function assign(proc: Proc, job: Uint8Array): boolean {
    // A channel whose shell Worker is up and idle first; else one that still needs its Worker.
    let slot = slots.findIndex((taken, index) => !taken && servers[index]!.isReady());
    if (slot < 0) slot = slots.findIndex(taken => !taken);
    if (slot < 0) return false;
    slots[slot] = proc;
    proc.slot = slot;
    if (!servers[slot]!.isReady() && !requested[slot]) {
      requested[slot] = true;
      postToPage({ t: "proc_need", slot } as unknown as WorkerMessage);
    }
    servers[slot]!.post(job);
    return true;
  }

  function spawn(fd: number, url: string, body: Uint8Array): void {
    const handle = machine.net.get(fd) as HttpHandle;
    const query = new URLSearchParams(url.split("?")[1] ?? "");
    const proc: Proc = {
      handle, fd, slot: -1, queued: 0, spawnedAt: performance.now(), startedAt: 0, killAt: 0, done: false,
      host: createShHost(vfs, (stream, data) => frame(proc, stream === 1 ? FRAME_STDOUT : FRAME_STDERR, data)),
    };
    handle.head = { status: 200, headers: new Uint8Array(0) };
    byFd.set(fd, proc);
    if (query.get("mode") === "inline") runInline(proc, body, Number(query.get("timeout") ?? 0));
    else if (!assign(proc, body)) waiting.push({ proc, job: body });
  }

  function kill(proc: Proc, signal: number): void {
    if (proc.done) return;
    if (proc.slot < 0) {
      const index = waiting.findIndex(entry => entry.proc === proc);
      if (index >= 0) waiting.splice(index, 1);
      finish(proc, 128 + signal, signal);
      return;
    }
    servers[proc.slot]!.kill(signal);
    proc.killAt ||= performance.now();
  }

  /** Answers what the shell Workers are waiting for. Runs inside every host call of the guest. */
  function serve(): void {
    for (let again = true; again; ) {
      again = false;
      for (let slot = 0; slot < servers.length; slot++) {
        const proc = slots[slot];
        if (!proc) continue;
        const server = servers[slot]!;
        if (!proc.startedAt && server.started()) proc.startedAt = server.startedAt();
        const answered = server.serve((op, n1, n2, s1, s2, data): Reply | null => {
          if (op === OP.EXIT) {
            finish(proc, n1, n2);
            return { rc: 0 };
          }
          // Back-pressure: a shell that prints faster than the guest reads waits in its write.
          if (op === OP.WRITE && (n1 === 1 || n1 === 2) && proc.queued > OUT_WINDOW) return null;
          return proc.host.call(op, n1, n2, s1, s2, data);
        });
        if (answered && !proc.done && server.linger(spinUs)) again = true;
        else if (answered && !proc.done && server.pending()) again = true;
        if (proc.killAt && !proc.done && performance.now() - proc.killAt > HARD_KILL_MS) {
          // It is computing without making a host call (`while :; do :; done`): only the page can stop it.
          server.reset();
          requested[slot] = true;
          postToPage({ t: "proc_replace", slot } as unknown as WorkerMessage);
          finish(proc, 137, 9);
        }
      }
    }
    while (waiting.length > 0 && assign(waiting[0]!.proc, waiting[0]!.job)) waiting.shift();
  }

  // ---- the three places this hooks into the unchanged host ------------------

  // 1. Traffic for our descriptors never reaches the page.
  machine.post = (message, transfer) => {
    if (message.t === "http_open" && message.url.startsWith("proc:")) {
      if (message.url.startsWith("proc:spawn")) spawn(message.handle, message.url, message.body ?? new Uint8Array(0));
      else if (message.url.startsWith("proc:kill")) {
        // `proc:kill?fd=N&sig=15`: a second descriptor that is at end of file at once.
        const query = new URLSearchParams(message.url.split("?")[1] ?? "");
        const target = byFd.get(Number(query.get("fd")));
        if (target) kill(target, Number(query.get("sig") ?? 15));
        const handle = machine.net.get(message.handle) as HttpHandle;
        handle.head = { status: target ? 200 : 404, headers: new Uint8Array(0) };
        handle.ended = true;
        byFd.set(message.handle, { done: true } as Proc);
      }
      return;
    }
    if (message.t === "http_ack" && byFd.has(message.handle)) {
      byFd.get(message.handle)!.queued -= message.bytes;
      return;
    }
    if (message.t === "net_close" && byFd.has(message.handle)) {
      const proc = byFd.get(message.handle)!;
      byFd.delete(message.handle);
      if (!proc.done) kill(proc, 9); // closing the descriptor of a running child ends it
      return;
    }
    postToPage(message, transfer);
  };

  // 2. Every host call that can block starts with pump(): serve the shells there.
  const pump = machine.pump.bind(machine);
  machine.pump = () => {
    pump();
    serve();
  };

  // 3. Sleeping: wake for a shell's call as for a keystroke. The shell bumps the ring's wake counter
  //    after writing its request, so sampling the counter before looking at the channels cannot miss one.
  const header = machine.ring.header;
  machine.waitUntil = deadlineMs => {
    const seen = Atomics.load(header, H_WAKE);
    if (Atomics.load(header, H_READ) !== Atomics.load(header, H_WRITE)) return;
    let wake = deadlineMs;
    for (let slot = 0; slot < servers.length; slot++) {
      const proc = slots[slot];
      if (!proc) continue;
      if (servers[slot]!.pending() && !(proc.queued > OUT_WINDOW)) return;
      if (!proc.startedAt && servers[slot]!.started()) return;
      if (proc.killAt) wake = Math.min(wake, proc.killAt + HARD_KILL_MS + 1);
    }
    const timeout = wake - performance.now();
    if (timeout <= 0) return;
    Atomics.wait(header, H_WAKE, seen, wake === Infinity ? undefined : timeout);
  };
}
