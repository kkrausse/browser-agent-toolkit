// Child processes for a guest: the process table behind the `proc_*` imports
// (docs/abi.md 3.4). A child is one run of the shell (`bat_sh.wasm`, see
// sh/wasm.ts): the guest gets ONE pollable descriptor that delivers the child's
// stdout, stderr and exit status as events, in order, as they happen.
//
// Two ways to run the shell, the same events either way:
//
//   worker  (default) a shell Worker runs it. Its file calls arrive over a
//           SharedArrayBuffer channel (sh/channel.ts) and are answered here, in
//           the guest's Worker, which owns the filesystem: at the top of every
//           blocking host call and inside every wait (`Machine.addWakeSource`).
//           Output streams while the guest keeps running; a command that will
//           not stop is ended by replacing its Worker.
//   inline  the shell runs to completion inside `proc_spawn`, in this Worker,
//           on the vfs directly. Nothing else runs meanwhile, stdin is at end
//           of file, and only a deadline can stop it. For machines where a
//           second Worker is not affordable or could not be started.
//
// The page creates the shell Workers (it is the only thread that is never
// blocked); this file asks for them with `proc_need` / `proc_replace`.

import type { Machine } from "./machine";
import type { ProcInit, WorkerMessage } from "./protocol";
import { type ChannelServer, createChannel, createChannelServer } from "./sh/channel";
import { createShHost, OP, type Reply, type ShHost } from "./sh/host";
import { createShRunner, ShAbort, type ShRunner } from "./sh/wasm";
import { ERRNO, type Vfs } from "./vfs";

export const PROC_STDOUT = 1;
export const PROC_STDERR = 2;
export const PROC_EXIT = 3;
/** `proc_spawn` flag: stdin stays open for `proc_send` (otherwise the child reads end of file). */
export const SPAWN_STDIN = 1;
/** Bytes of one exit event: i32 status, i32 signal, u32 queue µs, u32 run µs, u32 host calls. */
export const EXIT_BYTES = 20;

/** Output queued for the guest beyond which a shell Worker's writes are left unanswered. */
const OUT_WINDOW = 1 << 20;
/** Adjacent output of one stream is merged into one event up to this size. */
const MERGE_BYTES = 64 * 1024;
/** A killed shell Worker that has not ended by itself after this long is terminated by the page. */
const HARD_KILL_MS = 250;
/** Longest stretch one `serve()` spends answering shells before the guest gets its thread back. */
const SERVE_SLICE_MS = 4;
/** An inline run is abandoned (status 124) after this long: nothing else can stop it. */
const INLINE_LIMIT_MS = 120_000;
const EINTR = -4;

export interface ProcEvent {
  kind: number;
  data: Uint8Array;
}

export interface Proc {
  events: ProcEvent[];
  /** Bytes of output events not yet taken by the guest. */
  queued: number;
  stdin: Uint8Array[];
  stdinOpen: boolean;
  host: ShHost;
  /** Channel index while a shell Worker runs it; -1 queued or inline. */
  slot: number;
  spawnedAt: number;
  startedAt: number;
  killAt: number;
  killSignal: number;
  /** The exit event has been queued. */
  done: boolean;
  /** What the shell is waiting for that only the guest can supply: 0 nothing, 1 stdin, 2 room in the event queue. */
  waitingFor: number;
  command: string;
}

export interface Processes {
  /** Starts a child from an encoded request (docs/abi.md 3.4). Returns an errno on a malformed request. */
  spawn(request: Uint8Array, flags: number): Proc | number;
  /** Removes and returns the next event if `fits` accepts it. */
  take(proc: Proc, fits: (event: ProcEvent) => boolean): ProcEvent | undefined;
  /** Queues stdin bytes; `close` ends stdin after them. */
  send(proc: Proc, data: Uint8Array, close: boolean): number;
  signal(proc: Proc, signo: number): number;
  /** The guest closed the descriptor: a running child is killed. */
  close(proc: Proc): void;
}

export interface ProcOptions {
  machine: Machine;
  vfs: Vfs;
  init: ProcInit;
  /** Called after a run that changed files: the persistence hook `wasi.ts` calls on close. */
  onFsChange?(): void;
}

function decodeRequest(body: Uint8Array): { argv: string[]; env: string[]; cwd: string } | null {
  try {
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const decoder = new TextDecoder();
    const argc = view.getUint32(0, true);
    const envc = view.getUint32(4, true);
    if (argc === 0 || argc > 65536 || envc > 65536) return null;
    let at = 8;
    const text = () => {
      const length = view.getUint32(at, true);
      if (at + 4 + length > body.length) throw new RangeError("short request");
      const value = decoder.decode(body.subarray(at + 4, at + 4 + length));
      at += 4 + length;
      return value;
    };
    const cwd = text();
    return { cwd, argv: Array.from({ length: argc }, text), env: Array.from({ length: envc }, text) };
  } catch {
    return null;
  }
}

export function createProcesses({ machine, vfs, init, onFsChange }: ProcOptions): Processes {
  const encoder = new TextEncoder();
  const spinUs = init.spinUs;
  let mode = init.mode;
  const channels: SharedArrayBuffer[] = [];
  const servers: ChannelServer[] = [];
  const slots: (Proc | null)[] = [];
  const requested: boolean[] = [];
  for (let slot = 0; slot < (mode === "worker" ? init.slots : 0); slot++) {
    channels.push(createChannel());
    servers.push(createChannelServer(channels[slot]!));
    slots.push(null);
    requested.push(false);
  }
  const waiting: { proc: Proc; job: Uint8Array }[] = [];

  function needWorker(slot: number): void {
    if (requested[slot]) return;
    requested[slot] = true;
    machine.post({ t: "proc_need", slot, channel: channels[slot]! });
  }

  function push(proc: Proc, kind: number, data: Uint8Array): void {
    const last = proc.events[proc.events.length - 1];
    if (last && last.kind === kind && kind !== PROC_EXIT && last.data.length + data.length <= MERGE_BYTES) {
      const merged = new Uint8Array(last.data.length + data.length);
      merged.set(last.data);
      merged.set(data, last.data.length);
      last.data = merged;
    } else proc.events.push({ kind, data });
    proc.queued += data.length;
  }

  function finish(proc: Proc, status: number, signal: number): void {
    if (proc.done) return;
    proc.done = true;
    const now = performance.now();
    const started = proc.startedAt || now;
    const exit = new Uint8Array(EXIT_BYTES);
    const view = new DataView(exit.buffer);
    view.setInt32(0, status, true);
    view.setInt32(4, signal, true);
    view.setUint32(8, Math.max(0, Math.round((started - proc.spawnedAt) * 1000)), true);
    view.setUint32(12, Math.max(0, Math.round((now - started) * 1000)), true);
    view.setUint32(16, proc.host.calls(), true);
    proc.events.push({ kind: PROC_EXIT, data: exit });
    if (proc.slot >= 0) slots[proc.slot] = null;
    proc.slot = -1;
    proc.stdinOpen = false;
    proc.stdin.length = 0;
    machine.post({
      t: "proc_stat", command: proc.command, status, signal, calls: proc.host.calls(),
      queueMs: started - proc.spawnedAt, runMs: now - started,
    });
    if (proc.host.dirty()) onFsChange?.();
  }

  // ---- inline -----------------------------------------------------------------

  let inlineProc: Proc | null = null;
  let inlineDeadline = Infinity;
  let inlineRunner: ShRunner | null = null;
  const inlineCheckpoint = () => {
    if (performance.now() > inlineDeadline) throw new ShAbort(15, true);
  };
  const inlineSleeper = new Int32Array(new SharedArrayBuffer(4));

  function runInline(proc: Proc, request: { argv: string[]; env: string[]; cwd: string }): void {
    inlineRunner ??= createShRunner({
      module: init.module,
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
    inlineProc = proc;
    inlineDeadline = performance.now() + INLINE_LIMIT_MS;
    proc.startedAt = performance.now();
    proc.stdinOpen = false;
    try {
      finish(proc, inlineRunner.run(request), 0);
    } catch (thrown) {
      if (thrown instanceof ShAbort) finish(proc, thrown.timedOut ? 124 : 128 + thrown.signal, thrown.signal);
      else {
        push(proc, PROC_STDERR, encoder.encode(`sh: internal error: ${(thrown as Error)?.message ?? thrown}\n`));
        finish(proc, 134, 0);
      }
    }
    inlineProc = null;
  }

  // ---- shell Workers ----------------------------------------------------------

  function assign(proc: Proc, job: Uint8Array): boolean {
    // A channel whose shell Worker is up and idle first; else one that still needs its Worker.
    let slot = slots.findIndex((taken, index) => !taken && servers[index]!.isReady());
    if (slot < 0) slot = slots.findIndex(taken => !taken);
    if (slot < 0) return false;
    slots[slot] = proc;
    proc.slot = slot;
    if (!servers[slot]!.isReady()) needWorker(slot);
    servers[slot]!.post(job);
    return true;
  }

  function kill(proc: Proc, signal: number): void {
    if (proc.done) return;
    if (proc.slot < 0) {
      const index = waiting.findIndex(entry => entry.proc === proc);
      if (index >= 0) waiting.splice(index, 1);
      finish(proc, 128 + signal, signal);
      return;
    }
    proc.killSignal ||= signal;
    proc.killAt ||= performance.now();
    servers[proc.slot]!.kill(signal);
  }

  /** The shell's call cannot be answered until the guest reads events or supplies stdin. */
  function mustWait(proc: Proc, op: number, fd: number): number {
    if (op === OP.WRITE && (fd === 1 || fd === 2) && proc.queued > OUT_WINDOW) return 2;
    if (op === OP.READ && proc.host.isStdin(fd) && proc.stdinOpen && proc.stdin.length === 0) return 1;
    return 0;
  }
  const canAnswer = (proc: Proc) =>
    proc.waitingFor === 0 || proc.killSignal !== 0
    || (proc.waitingFor === 1 ? proc.stdin.length > 0 || !proc.stdinOpen : proc.queued <= OUT_WINDOW);

  /** Ends a child whose Worker will not come back: the page replaces the Worker, on a fresh channel
   * (whatever the old Worker still writes lands in memory nobody reads). */
  function replace(slot: number, proc: Proc): void {
    channels[slot] = createChannel();
    servers[slot] = createChannelServer(channels[slot]!);
    requested[slot] = true;
    machine.post({ t: "proc_replace", slot, channel: channels[slot]! });
    finish(proc, 128 + (proc.killSignal || 9), proc.killSignal || 9);
  }

  function serve(): void {
    if (servers.length === 0) return;
    const until = performance.now() + SERVE_SLICE_MS;
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
          proc.waitingFor = mustWait(proc, op, n1);
          if (proc.waitingFor) return proc.killSignal ? { rc: EINTR } : null;
          return proc.host.call(op, n1, n2, s1, s2, data);
        });
        if (answered && !proc.done && (server.linger(spinUs) || server.pending())) again = true;
        if (proc.killAt && !proc.done && performance.now() - proc.killAt > HARD_KILL_MS) {
          // It is computing without making a host call (`while :; do :; done`): only the page can stop it.
          replace(slot, proc);
        }
      }
      if (again && performance.now() > until) break;
    }
    while (waiting.length > 0 && assign(waiting[0]!.proc, waiting[0]!.job)) waiting.shift();
  }

  /** The page could not start a shell Worker: every child runs inline from now on. */
  function workersFailed(): void {
    if (mode === "inline") return;
    mode = "inline";
    const stranded: { proc: Proc; job: Uint8Array }[] = [...waiting.splice(0)];
    for (let slot = 0; slot < slots.length; slot++) {
      const proc = slots[slot];
      // A job that a Worker never picked up is still whole in its channel.
      if (proc && !servers[slot]!.started()) stranded.push({ proc, job: servers[slot]!.job() });
      else if (proc) finish(proc, 137, 9);
      slots[slot] = null;
    }
    servers.length = 0;
    for (const { proc, job } of stranded) {
      proc.slot = -1;
      const request = decodeRequest(job);
      if (request) runInline(proc, request);
      else finish(proc, 127, 0);
    }
  }
  machine.onProcWorker = (_slot, ok) => {
    if (!ok) workersFailed();
  };

  if (mode === "worker") {
    machine.addWakeSource({
      serve,
      pending() {
        for (let slot = 0; slot < servers.length; slot++) {
          const proc = slots[slot];
          if (!proc) continue;
          if (servers[slot]!.pending() && canAnswer(proc)) return true;
          if (!proc.startedAt && servers[slot]!.started()) return true;
        }
        return false;
      },
      deadline() {
        let deadline = Infinity;
        for (const proc of slots) if (proc?.killAt) deadline = Math.min(deadline, proc.killAt + HARD_KILL_MS + 1);
        return deadline;
      },
    });
    // One shell Worker up before the first command: starting one takes about 10 ms.
    for (let slot = 0; slot < Math.min(init.prewarm, servers.length); slot++) needWorker(slot);
  }

  return {
    spawn(request, flags) {
      const decoded = decodeRequest(request);
      if (!decoded) return ERRNO.INVAL;
      const proc: Proc = {
        events: [], queued: 0, stdin: [], stdinOpen: (flags & SPAWN_STDIN) !== 0, slot: -1,
        spawnedAt: performance.now(), startedAt: 0, killAt: 0, killSignal: 0, done: false, waitingFor: 0,
        command: decoded.argv.join(" ").slice(0, 300),
        host: createShHost(vfs, {
          output: (stream, data) => push(proc, stream === 1 ? PROC_STDOUT : PROC_STDERR, data),
          stdin(cap) {
            const chunk = proc.stdin[0];
            if (!chunk) return new Uint8Array(0);
            const taken = chunk.subarray(0, cap);
            if (taken.length === chunk.length) proc.stdin.shift();
            else proc.stdin[0] = chunk.subarray(taken.length);
            return taken;
          },
        }),
      };
      if (mode === "inline") runInline(proc, decoded);
      else if (!assign(proc, request.slice())) waiting.push({ proc, job: request.slice() });
      return proc;
    },
    take(proc, fits) {
      const event = proc.events[0];
      if (!event || !fits(event)) return undefined;
      proc.events.shift();
      if (event.kind !== PROC_EXIT) proc.queued -= event.data.length;
      return event;
    },
    send(proc, data, close) {
      if (proc.done || !proc.stdinOpen) return ERRNO.PIPE;
      if (data.length > 0) proc.stdin.push(data);
      if (close) proc.stdinOpen = false;
      return ERRNO.SUCCESS;
    },
    signal(proc, signo) {
      if (signo !== 2 && signo !== 9 && signo !== 15) return ERRNO.INVAL;
      kill(proc, signo);
      return ERRNO.SUCCESS;
    },
    close(proc) {
      kill(proc, 9);
      proc.events.length = 0;
      proc.queued = 0;
    },
  };
}
