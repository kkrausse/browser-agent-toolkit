// One shell Worker <-> the program's Worker, over a SharedArrayBuffer.
//
// The program's Worker owns the filesystem (plain JavaScript objects in its
// heap) and is, most of the time, blocked in Atomics.wait inside a guest
// syscall: it cannot take postMessage. So a shell running in another Worker
// makes its host calls the way the page delivers keystrokes: it writes the
// request into shared memory and bumps the wake counter the program's Worker
// sleeps on (H_WAKE of the page->Worker ring; adding to it is safe from any
// thread, only the ring's data has a single writer). The program's Worker
// answers the next time it is inside a host call.
//
//   shell Worker                          program's Worker
//   write request, REQ = 1
//   H_WAKE += 1, notify        ------->   wakes in poll_oneoff / fd_read
//   wait while REQ == 1                   serve: call sh-host, write reply
//   read reply, REQ = 0        <-------   REQ = 2, notify
//
// Starting a run is the same in the other direction: the program's Worker
// writes the run request and bumps JOB; an idle shell Worker sleeps on JOB.

import { type Call, OP, type Reply } from "./host";

export const C_READY = 0; // 1 once the shell Worker has its instance and waits for a job
export const C_JOB = 1; // bumped by the program's Worker to start a run (request in the data area)
export const C_REQ = 2; // 0 none, 1 call pending, 2 reply ready
export const C_KILL = 3; // signal number, set by the program's Worker; the shell ends at its next host call
export const C_RC = 4;
export const C_LEN = 5; // bytes of the request, then of the reply's data
export const C_STARTED = 6; // 1 once the shell Worker has picked the job up
export const C_INTS = 16;
/** Byte offset of an f64: when the shell Worker picked the job up, in ms since the Unix epoch (performance.timeOrigin + now()). */
export const C_STARTED_AT_BYTES = 8 * 4;
export const C_DATA = C_INTS * 4;
export const CHANNEL_BYTES = C_DATA + (1 << 20);
/** Largest run request (cwd, argv, environment) a channel carries. */
export const MAX_JOB_BYTES = 768 * 1024;

export const createChannel = (): SharedArrayBuffer => new SharedArrayBuffer(CHANNEL_BYTES);

const REQ_HEAD = 4 + 8 + 8 + 4 + 4 + 4; // op, n1, n2, len(s1), len(s2), len(data)
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(sab: SharedArrayBuffer, op: number, n1: number, n2: number, s1: string, s2: string, data: Uint8Array | null): void {
  const b1 = encoder.encode(s1);
  const b2 = encoder.encode(s2);
  const view = new DataView(sab, C_DATA);
  view.setInt32(0, op, true);
  view.setFloat64(4, n1, true);
  view.setFloat64(12, n2, true);
  view.setUint32(20, b1.length, true);
  view.setUint32(24, b2.length, true);
  view.setUint32(28, data?.length ?? 0, true);
  const out = new Uint8Array(sab, C_DATA + REQ_HEAD);
  out.set(b1, 0);
  out.set(b2, b1.length);
  if (data) out.set(data, b1.length + b2.length);
}

function decode(sab: SharedArrayBuffer): { op: number; n1: number; n2: number; s1: string; s2: string; data: Uint8Array | null } {
  const view = new DataView(sab, C_DATA);
  const l1 = view.getUint32(20, true);
  const l2 = view.getUint32(24, true);
  const l3 = view.getUint32(28, true);
  const at = C_DATA + REQ_HEAD;
  // TextDecoder refuses views of shared memory, hence the copies.
  return {
    op: view.getInt32(0, true),
    n1: view.getFloat64(4, true),
    n2: view.getFloat64(12, true),
    s1: decoder.decode(new Uint8Array(sab, at, l1).slice()),
    s2: decoder.decode(new Uint8Array(sab, at + l1, l2).slice()),
    data: l3 ? new Uint8Array(sab, at + l1 + l2, l3).slice() : null,
  };
}

/** How long each side stays awake looking for the other's next move before it sleeps. A wake-up
 * through the scheduler costs tens of microseconds; a shell command is hundreds of calls back to back. */
export const DEFAULT_SPIN_US = 50;

function spinUntil(ints: Int32Array, index: number, differsFrom: number, spinUs: number): boolean {
  if (Atomics.load(ints, index) !== differsFrom) return true;
  if (spinUs <= 0) return false;
  const until = performance.now() + spinUs / 1000;
  while (performance.now() < until) {
    if (Atomics.load(ints, index) !== differsFrom) return true;
  }
  return false;
}

// ---- shell Worker side ------------------------------------------------------

export interface ChannelClient {
  call: Call;
  /** Blocks until the program's Worker posts a run; returns its request bytes. */
  nextJob(): Uint8Array;
  /** The signal the program's Worker asked this run to end with, 0 if none. */
  killed(): number;
  ready(): void;
}

export function createChannelClient(sab: SharedArrayBuffer, parentHeader: Int32Array, wakeIndex: number, spinUs: number): ChannelClient {
  const ints = new Int32Array(sab, 0, C_INTS);
  let jobSeen = 0;
  const wakeParent = () => {
    Atomics.add(parentHeader, wakeIndex, 1);
    Atomics.notify(parentHeader, wakeIndex);
  };
  return {
    ready: () => void Atomics.store(ints, C_READY, 1),
    killed: () => Atomics.load(ints, C_KILL),
    nextJob() {
      while (Atomics.load(ints, C_JOB) === jobSeen) Atomics.wait(ints, C_JOB, jobSeen);
      jobSeen = Atomics.load(ints, C_JOB);
      const job = new Uint8Array(sab, C_DATA, Atomics.load(ints, C_LEN)).slice();
      new Float64Array(sab, C_STARTED_AT_BYTES, 1)[0] = performance.timeOrigin + performance.now();
      Atomics.store(ints, C_STARTED, 1);
      return job;
    },
    call(op, n1, n2, s1, s2, data): Reply {
      encode(sab, op, n1, n2, s1, s2, data);
      Atomics.store(ints, C_REQ, 1);
      wakeParent();
      if (!spinUntil(ints, C_REQ, 1, spinUs)) {
        while (Atomics.load(ints, C_REQ) === 1) {
          Atomics.wait(ints, C_REQ, 1, 50);
          // The reply to a call is withheld while the reader of this shell's output is behind
          // (back-pressure); a kill must still get through. EXIT itself is never abandoned.
          if (op !== OP.EXIT && Atomics.load(ints, C_KILL) !== 0 && Atomics.compareExchange(ints, C_REQ, 1, 0) === 1) return { rc: -4 /* EINTR */ };
        }
      }
      const rc = Atomics.load(ints, C_RC);
      const length = Atomics.load(ints, C_LEN);
      const reply: Reply = { rc, data: length ? new Uint8Array(sab, C_DATA, length).slice() : undefined };
      Atomics.store(ints, C_REQ, 0);
      return reply;
    },
  };
}

// ---- program's Worker side --------------------------------------------------

export interface ChannelServer {
  ints: Int32Array;
  isReady(): boolean;
  started(): boolean;
  /** When the shell Worker picked the job up, on this thread's performance.now() scale. */
  startedAt(): number;
  /** Starts a run in the shell Worker. */
  post(job: Uint8Array): void;
  /** The posted run's request, while no shell Worker has picked it up (afterwards the data area is the shell's). */
  job(): Uint8Array;
  kill(signal: number): void;
  /** A call from the shell is waiting for its reply. */
  pending(): boolean;
  /** Serves the waiting call, if any. `handle` returns null to leave it waiting (back-pressure). True if one was answered. */
  serve(handle: (op: number, n1: number, n2: number, s1: string, s2: string, data: Uint8Array | null) => Reply | null): boolean;
  /** After answering, stays awake this long for the shell's next call. */
  linger(spinUs: number): boolean;
}

export function createChannelServer(sab: SharedArrayBuffer): ChannelServer {
  const ints = new Int32Array(sab, 0, C_INTS);
  return {
    ints,
    isReady: () => Atomics.load(ints, C_READY) === 1,
    started: () => Atomics.load(ints, C_STARTED) === 1,
    startedAt: () => new Float64Array(sab, C_STARTED_AT_BYTES, 1)[0]! - performance.timeOrigin,
    pending: () => Atomics.load(ints, C_REQ) === 1,
    post(job) {
      new Uint8Array(sab, C_DATA, job.length).set(job);
      Atomics.store(ints, C_LEN, job.length);
      Atomics.store(ints, C_KILL, 0);
      Atomics.store(ints, C_STARTED, 0);
      Atomics.add(ints, C_JOB, 1);
      Atomics.notify(ints, C_JOB);
    },
    job: () => new Uint8Array(sab, C_DATA, Atomics.load(ints, C_LEN)).slice(),
    kill(signal) {
      Atomics.store(ints, C_KILL, signal);
      Atomics.notify(ints, C_REQ);
    },
    serve(handle) {
      if (Atomics.load(ints, C_REQ) !== 1) return false;
      const request = decode(sab);
      const reply = handle(request.op, request.n1, request.n2, request.s1, request.s2, request.data);
      if (!reply) return false;
      if (reply.data?.length) new Uint8Array(sab, C_DATA, reply.data.length).set(reply.data);
      Atomics.store(ints, C_RC, reply.rc);
      Atomics.store(ints, C_LEN, reply.data?.length ?? 0);
      // The shell may have given up on this call (killed while it waited): then there is nobody to answer.
      if (Atomics.compareExchange(ints, C_REQ, 1, 2) === 1) Atomics.notify(ints, C_REQ);
      return true;
    },
    linger(spinUs) {
      if (spinUs <= 0) return Atomics.load(ints, C_REQ) === 1;
      const until = performance.now() + spinUs / 1000;
      do {
        if (Atomics.load(ints, C_REQ) === 1) return true;
      } while (performance.now() < until);
      return false;
    },
  };
}
