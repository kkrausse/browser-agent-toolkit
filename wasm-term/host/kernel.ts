// Typed wrapper over the kernel wasm module (kernel/src/wasm.rs).

interface KernelExports {
  memory: WebAssembly.Memory;
  k_buf(): number;
  k_buf_size(): number;
  pty_new(cols: number, rows: number): number;
  pty_master_write(id: number, len: number, nowMs: number): void;
  pty_master_read(id: number): number;
  pty_master_pending(id: number): number;
  pty_slave_write(id: number, len: number): number;
  pty_slave_read_begin(id: number, nowMs: number): void;
  pty_slave_read(id: number, cap: number, nowMs: number): number;
  pty_read_deadline(): number;
  pty_poll_in(id: number): number;
  pty_readable_len(id: number): number;
  pty_tcgetattr(id: number): void;
  pty_tcsetattr(id: number, action: number): void;
  pty_winsize_get(id: number): void;
  pty_winsize_set(id: number, cols: number, rows: number, xpixel: number, ypixel: number): void;
  pty_take_signals(id: number): number;
  pty_hangup(id: number): void;
}

export const TERMIOS_SIZE = 44;
export const WINSIZE_SIZE = 8;

/** One pty, seen from both ends. All methods are synchronous and never block. */
export interface Pty {
  /** Terminal → line discipline (what the user typed). */
  masterWrite(data: Uint8Array): void;
  /** Line discipline → terminal: everything pending (echo + program output). */
  masterRead(): Uint8Array;
  /** Program output through OPOST. */
  slaveWrite(data: Uint8Array): void;
  slaveReadBegin(): void;
  /** Returns the bytes read (possibly empty = EOF/timeout), or the time to
   * retry at when the read would block (Infinity: wait for input). */
  slaveRead(cap: number): Uint8Array | { retryAt: number };
  pollIn(): boolean;
  /** FIONREAD: bytes a read could return right now. */
  readableLen(): number;
  getTermios(): Uint8Array;
  setTermios(action: number, termios: Uint8Array): void;
  getWinsize(): Uint8Array;
  setWinsize(cols: number, rows: number, xpixel: number, ypixel: number): void;
  /** Pending signals as a bitmask of `1 << signo`; clears them. */
  takeSignals(): number;
  hangup(): void;
}

export async function loadKernel(module: WebAssembly.Module): Promise<{ createPty(cols: number, rows: number): Pty }> {
  const instance = await WebAssembly.instantiate(module, {});
  const k = instance.exports as unknown as KernelExports;
  const bufPtr = k.k_buf();
  const bufSize = k.k_buf_size();
  // The kernel's memory can grow, so never cache a view across calls.
  const buf = () => new Uint8Array(k.memory.buffer, bufPtr, bufSize);
  const now = () => performance.now();

  return {
    createPty(cols, rows) {
      const id = k.pty_new(cols, rows);
      return {
        masterWrite(data) {
          for (let at = 0; at < data.length; at += bufSize) {
            const chunk = data.subarray(at, at + bufSize);
            buf().set(chunk);
            k.pty_master_write(id, chunk.length, now());
          }
        },
        masterRead() {
          const parts: Uint8Array[] = [];
          let total = 0;
          for (;;) {
            const n = k.pty_master_read(id);
            if (n === 0) break;
            parts.push(buf().slice(0, n));
            total += n;
          }
          if (parts.length === 1) return parts[0]!;
          const out = new Uint8Array(total);
          let at = 0;
          for (const part of parts) {
            out.set(part, at);
            at += part.length;
          }
          return out;
        },
        slaveWrite(data) {
          for (let at = 0; at < data.length; at += bufSize) {
            const chunk = data.subarray(at, at + bufSize);
            buf().set(chunk);
            k.pty_slave_write(id, chunk.length);
          }
        },
        slaveReadBegin() {
          k.pty_slave_read_begin(id, now());
        },
        slaveRead(cap) {
          const n = k.pty_slave_read(id, Math.min(cap, bufSize), now());
          if (n >= 0) return buf().slice(0, n);
          const deadline = k.pty_read_deadline();
          return { retryAt: deadline < 0 ? Infinity : deadline };
        },
        pollIn: () => k.pty_poll_in(id) === 1,
        readableLen: () => k.pty_readable_len(id),
        getTermios() {
          k.pty_tcgetattr(id);
          return buf().slice(0, TERMIOS_SIZE);
        },
        setTermios(action, termios) {
          buf().set(termios.subarray(0, TERMIOS_SIZE));
          k.pty_tcsetattr(id, action);
        },
        getWinsize() {
          k.pty_winsize_get(id);
          return buf().slice(0, WINSIZE_SIZE);
        },
        setWinsize(cols, rows, xpixel, ypixel) {
          k.pty_winsize_set(id, cols, rows, xpixel, ypixel);
        },
        takeSignals: () => k.pty_take_signals(id),
        hangup: () => k.pty_hangup(id),
      };
    },
  };
}
