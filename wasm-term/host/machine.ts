// The emulated machine as seen from inside the program's Worker: the pty, the
// inbound event ring, signal state and network handles. It knows nothing about
// WASI; `wasi.ts` (and, later, a node-style shim for JS programs) sits on top.

import type { Pty } from "./kernel";
import {
  FRAME_CLIPBOARD, FRAME_INPUT, FRAME_NET, FRAME_RESIZE, FRAME_SIGNAL, H_OUT_ACK, HTTP_BODY, HTTP_END, HTTP_ERROR, HTTP_HEAD,
  OUT_WINDOW, WS_CLOSE, WS_ERROR, type WorkerMessage,
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
  events: { kind: number; data: Uint8Array }[];
  /** A CLOSE or ERROR event has been queued; nothing more will arrive. */
  finished: boolean;
}

export interface HttpHandle {
  kind: "http";
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

export type NetHandle = WsHandle | HttpHandle;

export interface Machine {
  pty: Pty;
  /** The inbound ring; a non-blocking consumer waits on its wake counter (`H_WAKE`). */
  ring: RingReader;
  /** Processes everything the page has sent: input through the line
   * discipline, resizes, network events, signals. Flushes echo to the page.
   * Throws ProcessExit when a signal with default disposition is fatal. */
  pump(): void;
  /** Blocks until the page sends something or `deadlineMs` (performance.now
   * time base; Infinity = no deadline) passes. Does not pump. */
  waitUntil(deadlineMs: number): void;
  /** Sends pending pty output to the page (applies output flow control). */
  flushOutput(): void;
  /** Bytes sent to the page so far, and how many times a flush had to wait for the page to catch up. */
  outputStats(): { bytes: number; waits: number };
  post(message: WorkerMessage, transfer?: Transferable[]): void;

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
}

export function createMachine(pty: Pty, ring: RingReader, postMessage: (message: WorkerMessage, transfer: Transferable[]) => void): Machine {
  const dispositions = new Map<number, number>();
  const signalQueues = new Set<SignalQueue>();
  let caughtSeq = 0;
  let outSent = 0;
  let outBytes = 0;
  let outWaits = 0;
  const net = new Map<number, NetHandle>();

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
    for (;;) {
      const acked = Atomics.load(ring.header, H_OUT_ACK) >>> 0;
      if (((outSent - acked) >>> 0) < OUT_WINDOW) break;
      outWaits++;
      Atomics.wait(ring.header, H_OUT_ACK, acked | 0, 100);
    }
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
      }
    }
    if (consumed && ring.writerWaiting()) post({ t: "drain" });
    flushOutput(); // echo
    const mask = pty.takeSignals();
    for (let signo = 1; signo < NSIG; signo++) {
      if (mask & (1 << signo)) signals.push(signo);
    }
    for (const signo of signals) deliver(signo);
  }

  const machine: Machine = {
    pty,
    ring,
    pump,
    waitUntil(deadlineMs) {
      ring.wait(deadlineMs === Infinity ? Infinity : deadlineMs - performance.now());
    },
    flushOutput,
    outputStats: () => ({ bytes: outBytes, waits: outWaits }),
    post,
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
  };
  return machine;
}
