// Single-producer (page) / single-consumer (Worker) frame ring over a
// SharedArrayBuffer. See protocol.ts for why inbound traffic needs this.

import {
  FRAME_MORE, H_READ, H_WAKE, H_WRITE, H_WRITER_WAITING, HEADER_BYTES, MAX_FRAME_PAYLOAD, RING_BYTES,
} from "./protocol";

const FRAME_HEADER = 8; // u32 payload length, u8 type, 3 pad

export function createShared(): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER_BYTES + RING_BYTES);
}

export interface RingWriter {
  /** Queues a frame. Never blocks: frames that do not fit wait in memory. */
  send(type: number, payload: Uint8Array): void;
  /** Retries queued frames; call when the Worker reports it drained the ring. */
  flush(): void;
}

export function createRingWriter(sab: SharedArrayBuffer): RingWriter {
  const header = new Int32Array(sab, 0, HEADER_BYTES / 4);
  const data = new Uint8Array(sab, HEADER_BYTES, RING_BYTES);
  const pending: { type: number; payload: Uint8Array }[] = [];

  function free(): number {
    const used = (Atomics.load(header, H_WRITE) - Atomics.load(header, H_READ)) >>> 0;
    return RING_BYTES - used;
  }

  function put(type: number, payload: Uint8Array): void {
    let pos = Atomics.load(header, H_WRITE) >>> 0;
    const head = new Uint8Array(FRAME_HEADER);
    new DataView(head.buffer).setUint32(0, payload.length, true);
    head[4] = type;
    for (const part of [head, payload]) {
      let offset = pos % RING_BYTES;
      const first = Math.min(part.length, RING_BYTES - offset);
      data.set(part.subarray(0, first), offset);
      if (first < part.length) data.set(part.subarray(first), 0);
      pos = (pos + part.length) >>> 0;
      offset = pos % RING_BYTES;
    }
    // Keep frames 4-byte aligned so the header never straddles oddly.
    pos = (pos + ((4 - (payload.length & 3)) & 3)) >>> 0;
    Atomics.store(header, H_WRITE, pos | 0);
  }

  function flush(): void {
    let wrote = false;
    while (pending.length > 0) {
      const next = pending[0]!;
      if (free() < FRAME_HEADER + next.payload.length + 4) break;
      put(next.type, next.payload);
      pending.shift();
      wrote = true;
    }
    Atomics.store(header, H_WRITER_WAITING, pending.length > 0 ? 1 : 0);
    if (wrote) {
      Atomics.add(header, H_WAKE, 1);
      Atomics.notify(header, H_WAKE);
    }
  }

  return {
    send(type, payload) {
      if (payload.length <= MAX_FRAME_PAYLOAD) {
        pending.push({ type, payload });
      } else {
        for (let at = 0; at < payload.length; at += MAX_FRAME_PAYLOAD) {
          const end = Math.min(payload.length, at + MAX_FRAME_PAYLOAD);
          pending.push({ type: end < payload.length ? type | FRAME_MORE : type, payload: payload.subarray(at, end) });
        }
      }
      flush();
    },
    flush,
  };
}

export interface RingReader {
  /** Removes and returns the next complete frame, or null when the ring is empty. */
  next(): { type: number; payload: Uint8Array } | null;
  /** Blocks until the page writes something or `timeoutMs` passes (Infinity = no timeout). */
  wait(timeoutMs: number): void;
  /** True when the page is holding frames that did not fit. */
  writerWaiting(): boolean;
  header: Int32Array;
}

export function createRingReader(sab: SharedArrayBuffer): RingReader {
  const header = new Int32Array(sab, 0, HEADER_BYTES / 4);
  const data = new Uint8Array(sab, HEADER_BYTES, RING_BYTES);
  let partial: Uint8Array[] = [];

  function copyOut(pos: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    const offset = pos % RING_BYTES;
    const first = Math.min(length, RING_BYTES - offset);
    out.set(data.subarray(offset, offset + first), 0);
    if (first < length) out.set(data.subarray(0, length - first), first);
    return out;
  }

  return {
    header,
    next() {
      for (;;) {
        const read = Atomics.load(header, H_READ) >>> 0;
        const write = Atomics.load(header, H_WRITE) >>> 0;
        if (read === write) return null;
        const head = copyOut(read, FRAME_HEADER);
        const length = new DataView(head.buffer).getUint32(0, true);
        const type = head[4]!;
        const payload = copyOut((read + FRAME_HEADER) >>> 0, length);
        const advance = FRAME_HEADER + length + ((4 - (length & 3)) & 3);
        Atomics.store(header, H_READ, ((read + advance) >>> 0) | 0);
        if (type & FRAME_MORE) {
          partial.push(payload);
          continue;
        }
        if (partial.length === 0) return { type, payload };
        partial.push(payload);
        const total = partial.reduce((sum, part) => sum + part.length, 0);
        const joined = new Uint8Array(total);
        let at = 0;
        for (const part of partial) {
          joined.set(part, at);
          at += part.length;
        }
        partial = [];
        return { type, payload: joined };
      }
    },
    wait(timeoutMs) {
      const seen = Atomics.load(header, H_WAKE);
      // Re-check after sampling the wake counter so a write between the last
      // `next()` and this wait is not missed.
      if (Atomics.load(header, H_READ) !== Atomics.load(header, H_WRITE)) return;
      if (timeoutMs <= 0) return;
      Atomics.wait(header, H_WAKE, seen, timeoutMs === Infinity ? undefined : timeoutMs);
    },
    writerWaiting() {
      return Atomics.load(header, H_WRITER_WAITING) === 1;
    },
  };
}
