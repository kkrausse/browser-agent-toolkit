// The emulated machine as seen from inside the program's Worker: the pty, the
// inbound event ring, signal state and network handles. It knows nothing about
// WASI; `wasi.ts` (and, later, a node-style shim for JS programs) sits on top.

import type { Pty } from "./kernel";
import {
  FRAME_CLIPBOARD, FRAME_FILE, FRAME_INPUT, FRAME_NET, FRAME_PROC, FRAME_RESIZE, FRAME_SIGNAL, H_OUT_ACK, H_OUT_WAITING, H_READ, H_WAKE, H_WRITE,
  HTTP_BODY, HTTP_END, HTTP_ERROR, HTTP_HEAD, OUT_WINDOW, TCP_ACK, TCP_DATA, TCP_END, TCP_ERROR, TCP_OPEN, WS_CLOSE, WS_ERROR, type WorkerMessage,
} from "./protocol";
import type { RingReader } from "./ring";

export const SIGHUP = 1;
export const SIGINT = 2;
export const SIGQUIT = 3;
export const SIGKILL = 9;
export const SIGTERM = 15;
export const SIGTSTP = 20;
export const SIGWINCH = 28;
export const NSIG = 32;

export const SIG_DFL = 0;
export const SIG_IGN = 1;
export const SIG_CATCH = 2;

/** Signals whose default action is to do nothing (no job control here, so the stop signals too). */
const DEFAULT_IGNORED = new Set([SIGWINCH, 17 /* CHLD */, 18 /* CONT */, 19 /* STOP */, SIGTSTP, 21, 22, 23 /* URG */]);

/** Thrown through the guest's stack to end the program. */
export class ProcessExit extends Error {
  constructor(readonly code: number, readonly signal?: number) {
    super(signal ? `killed by signal ${signal}` : `exit ${code}`);
  }
}

export interface WsHandle {
  kind: "ws";
  /** The handle in messages to and from the page (unique for the program's life). */
  id: number;
  events: { kind: number; data: Uint8Array }[];
  /** A CLOSE or ERROR event has been queued; nothing more will arrive. */
  finished: boolean;
}

export interface HttpHandle {
  kind: "http";
  /** The handle in messages to and from the page (unique for the program's life). */
  id: number;
  head: { status: number; headers: Uint8Array } | null;
  chunks: Uint8Array[];
  ended: boolean;
  error: string | null;
}

/** The state behind one signalfd-style descriptor. */
export interface SignalQueue {
  mask: number;
  /** Pending signal numbers in arrival order; a signal is pending at most once. */
  pending: number[];
}

/** A TCP stream through the page's relay (docs/abi.md 3.3, "TCP"). */
export interface TcpHandle {
  kind: "tcp";
  /** The handle in messages to and from the page (unique for the program's life). */
  id: number;
  state: "connecting" | "open" | "failed";
  /** Why it failed: a WASI errno and what the relay or the browser said. */
  errno: number;
  error: string;
  /** Received and not yet read. */
  chunks: Uint8Array[];
  buffered: number;
  /** The peer closed its sending side. */
  eof: boolean;
  /** Bytes given to the page, and how many of them the relay has written to its socket. */
  sent: number;
  acked: number;
  /** The guest shut its sending side down. */
  writeShut: boolean;
  /** Edge-triggered readiness (`tcp_connect` flag 1): `poll_oneoff` reports a direction once
   * per change, which is what a reactor that caches readiness (tokio over mio) needs. */
  edge: boolean;
  readEdge: boolean;
  writeEdge: boolean;
}

export type NetHandle = WsHandle | HttpHandle | TcpHandle;

/** Something besides the page that the program's Worker must answer while it is blocked:
 * the shell Workers of `proc.ts`, whose file calls arrive over shared memory. A source wakes
 * the Worker by bumping the ring's wake counter (`H_WAKE`) after it has posted its request. */
export interface WakeSource {
  /** Answers everything that can be answered now. Called from `pump()` and from every wait. Must not call `pump()` or `flushOutput()`. */
  serve(): void;
  /** True while something is waiting that `serve()` could answer right now: the Worker must not sleep. */
  pending(): boolean;
  /** A time (performance.now base) at which `serve()` wants to run even if nothing arrives; Infinity = none. */
  deadline(): number;
}

export interface Machine {
  pty: Pty;
  /** The inbound ring; a non-blocking consumer waits on its wake counter (`H_WAKE`). */
  ring: RingReader;
  /** Processes everything the page has sent: input through the line
   * discipline, resizes, network events, signals. Flushes echo to the page.
   * Throws ProcessExit when a signal with default disposition is fatal. */
  pump(): void;
  /** Blocks until the page sends something, a wake source has work, or `deadlineMs`
   * (performance.now time base; Infinity = no deadline) passes. Does not pump. */
  waitUntil(deadlineMs: number): void;
  /** Sends pending pty output to the page (applies output flow control). */
  flushOutput(): void;
  /** Bytes sent to the page so far, and how many times a flush had to wait for the page to catch up. */
  outputStats(): { bytes: number; waits: number };
  post(message: WorkerMessage, transfer?: Transferable[]): void;
  /** Registers a wake source (see `WakeSource`). */
  addWakeSource(source: WakeSource): void;

  /** Returns the previous disposition. */
  setDisposition(signo: number, disposition: number): number;
  /** Opens a queue that receives the caught signals named in `mask` (bits `1 << signo`). */
  openSignalQueue(mask: number): SignalQueue;
  closeSignalQueue(queue: SignalQueue): void;
  /** Bumped whenever a signal is caught; lets a blocking call notice. */
  caughtSeq(): number;
  raise(signo: number): void;

  net: Map<number, NetHandle>;
  lastError: string;
  /** Called from `pump()` with the page's answer to a `clipboard_read` request. */
  onClipboard: ((id: number, ok: boolean, text: string) => void) | null;
  /** Called from `pump()` when the page asks for a file or a directory listing (`Program.readFile` / `listFiles`). */
  onFile: ((id: number, op: number, path: string) => void) | null;
  /** Called from `pump()` when the page reports on a shell Worker it was asked for (`proc.ts`). */
  onProcWorker: ((slot: number, ok: boolean) => void) | null;
}

export function createMachine(pty: Pty, ring: RingReader, postMessage: (message: WorkerMessage, transfer: Transferable[]) => void): Machine {
  const dispositions = new Map<number, number>();
  const signalQueues = new Set<SignalQueue>();
  let caughtSeq = 0;
  let outSent = 0;
  let outBytes = 0;
  let outWaits = 0;
  const net = new Map<number, NetHandle>();
  const sources: WakeSource[] = [];
  const header = ring.header;

  function serveSources(): void {
    for (const source of sources) source.serve();
  }
  const sourcesPending = () => sources.some(source => source.pending());
  function sourcesDeadline(): number {
    let deadline = Infinity;
    for (const source of sources) deadline = Math.min(deadline, source.deadline());
    return deadline;
  }

  function post(message: WorkerMessage, transfer: Transferable[] = []): void {
    postMessage(message, transfer);
  }

  function flushOutput(): void {
    const data = pty.masterRead();
    if (data.length === 0) return;
    outSent = (outSent + data.length) >>> 0;
    outBytes += data.length;
    post({ t: "out", data }, [data.buffer]);
    // Flow control: a program that prints in a tight loop must not queue
    // unbounded messages on the page. Wait for the page to catch up.
    // The wait is on the ring's wake counter, not on the ack word, so that a shell Worker's
    // file call is answered here too: a program blocked on its own output must not stall its
    // children. The page bumps the wake counter with an ack only while H_OUT_WAITING is set.
    let waiting = false;
    for (;;) {
      const acked = Atomics.load(header, H_OUT_ACK) >>> 0;
      if (((outSent - acked) >>> 0) < OUT_WINDOW) break;
      if (!waiting) {
        waiting = true;
        outWaits++;
        Atomics.store(header, H_OUT_WAITING, 1);
      }
      const seen = Atomics.load(header, H_WAKE);
      if ((Atomics.load(header, H_OUT_ACK) >>> 0) !== acked) continue;
      serveSources();
      if (sourcesPending()) continue;
      Atomics.wait(header, H_WAKE, seen, Math.max(1, Math.min(100, sourcesDeadline() - performance.now())));
    }
    if (waiting) Atomics.store(header, H_OUT_WAITING, 0);
  }

  function deliver(signo: number): void {
    const disposition = signo === SIGKILL ? SIG_DFL : dispositions.get(signo) ?? SIG_DFL;
    if (disposition === SIG_IGN) return;
    if (disposition === SIG_CATCH) {
      for (const queue of signalQueues) {
        if (queue.mask & (1 << signo) && !queue.pending.includes(signo)) queue.pending.push(signo);
      }
      caughtSeq++;
      return;
    }
    if (DEFAULT_IGNORED.has(signo)) return;
    flushOutput();
    throw new ProcessExit(128 + signo, signo);
  }

  function netEvent(payload: Uint8Array): void {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const handle = net.get(view.getUint32(0, true));
    const kind = view.getUint32(4, true);
    const data = payload.subarray(8);
    if (!handle) return; // closed by the guest while the event was in flight
    if (handle.kind === "tcp") {
      if (kind === TCP_OPEN) {
        if (handle.state === "connecting") handle.state = "open";
        handle.writeEdge = true;
      } else if (kind === TCP_DATA) {
        handle.chunks.push(data);
        handle.buffered += data.length;
        handle.readEdge = true;
      } else if (kind === TCP_END) {
        handle.eof = true;
        handle.readEdge = true;
      } else if (kind === TCP_ACK) {
        handle.acked += new DataView(data.buffer, data.byteOffset).getUint32(0, true);
      } else if (kind === TCP_ERROR) {
        handle.state = "failed";
        handle.errno = new DataView(data.buffer, data.byteOffset).getUint32(0, true);
        handle.error = new TextDecoder().decode(data.subarray(4));
        // Both directions: a reader and a writer each have to find out.
        handle.readEdge = true;
        handle.writeEdge = true;
      }
      return;
    }
    if (handle.kind === "ws") {
      handle.events.push({ kind, data });
      if (kind === WS_CLOSE || kind === WS_ERROR) handle.finished = true;
      return;
    }
    if (kind === HTTP_HEAD) {
      handle.head = { status: new DataView(data.buffer, data.byteOffset).getUint32(0, true), headers: data.subarray(4) };
    } else if (kind === HTTP_BODY) {
      handle.chunks.push(data);
    } else if (kind === HTTP_END) {
      handle.ended = true;
    } else if (kind === HTTP_ERROR) {
      handle.error = new TextDecoder().decode(data);
      handle.ended = true;
    }
  }

  function pump(): void {
    let consumed = false;
    const signals: number[] = [];
    for (;;) {
      const frame = ring.next();
      if (!frame) break;
      consumed = true;
      if (frame.type === FRAME_INPUT) {
        pty.masterWrite(frame.payload);
      } else if (frame.type === FRAME_RESIZE) {
        const view = new DataView(frame.payload.buffer, frame.payload.byteOffset);
        pty.setWinsize(view.getUint16(0, true), view.getUint16(2, true), view.getUint16(4, true), view.getUint16(6, true));
      } else if (frame.type === FRAME_SIGNAL) {
        signals.push(new DataView(frame.payload.buffer, frame.payload.byteOffset).getUint32(0, true));
      } else if (frame.type === FRAME_NET) {
        netEvent(frame.payload);
      } else if (frame.type === FRAME_CLIPBOARD) {
        const view = new DataView(frame.payload.buffer, frame.payload.byteOffset);
        machine.onClipboard?.(view.getUint32(0, true), view.getUint32(4, true) === 1, new TextDecoder().decode(frame.payload.subarray(8)));
      } else if (frame.type === FRAME_FILE) {
        const view = new DataView(frame.payload.buffer, frame.payload.byteOffset);
        machine.onFile?.(view.getUint32(0, true), view.getUint32(4, true), new TextDecoder().decode(frame.payload.subarray(8)));
      } else if (frame.type === FRAME_PROC) {
        const view = new DataView(frame.payload.buffer, frame.payload.byteOffset);
        machine.onProcWorker?.(view.getUint32(0, true), view.getUint32(4, true) === 1);
      }
    }
    if (consumed && ring.writerWaiting()) post({ t: "drain" });
    flushOutput(); // echo
    const mask = pty.takeSignals();
    for (let signo = 1; signo < NSIG; signo++) {
      if (mask & (1 << signo)) signals.push(signo);
    }
    for (const signo of signals) deliver(signo);
    serveSources();
  }

  const machine: Machine = {
    pty,
    ring,
    pump,
    waitUntil(deadlineMs) {
      if (sources.length === 0) {
        ring.wait(deadlineMs === Infinity ? Infinity : deadlineMs - performance.now());
        return;
      }
      // A source bumps the wake counter after posting its request, so sampling the counter
      // before looking at the sources cannot miss one.
      const seen = Atomics.load(header, H_WAKE);
      if (Atomics.load(header, H_READ) !== Atomics.load(header, H_WRITE)) return;
      if (sourcesPending()) return;
      const wake = Math.min(deadlineMs, sourcesDeadline());
      const timeout = wake - performance.now();
      if (timeout <= 0) return;
      Atomics.wait(header, H_WAKE, seen, wake === Infinity ? undefined : timeout);
    },
    flushOutput,
    outputStats: () => ({ bytes: outBytes, waits: outWaits }),
    post,
    addWakeSource(source) {
      sources.push(source);
    },
    setDisposition(signo, disposition) {
      const previous = dispositions.get(signo) ?? SIG_DFL;
      dispositions.set(signo, disposition);
      return previous;
    },
    openSignalQueue(mask) {
      const queue: SignalQueue = { mask, pending: [] };
      signalQueues.add(queue);
      return queue;
    },
    closeSignalQueue(queue) {
      signalQueues.delete(queue);
    },
    caughtSeq: () => caughtSeq,
    raise: deliver,
    net,
    lastError: "",
    onClipboard: null,
    onFile: null,
    onProcWorker: null,
  };
  return machine;
}
