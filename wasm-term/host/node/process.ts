// The `process` object of a JavaScript program on the machine (../machine.ts):
//
//   process.stdin.setRawMode(on)        tcgetattr/tcsetattr with libuv's raw-mode bits
//   process.stdin "data"                pty slave reads, after each pump
//   process.stdout/stderr.write         pty slave write (OPOST applies) + flush to the page
//   process.stdout.columns/.rows        the pty's window size
//   stdout "resize", process "SIGWINCH" the pty's SIGWINCH
//   process.on("SIGINT"/...)            the signal's disposition becomes "catch" while a listener exists;
//                                       without one the default action applies (SIGINT ends the program with 130)
//
// Created by runtime.ts and installed as globalThis.process before the
// program's bundle is evaluated.

import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { type Machine, NSIG, ProcessExit, SIG_CATCH, SIG_DFL, SIGWINCH } from "../machine";

// termios flag bits (Linux values, as in kernel/src/termios.rs).
const BRKINT = 0x2, INPCK = 0x10, ISTRIP = 0x20, ICRNL = 0x100, IXON = 0x400;
const CS8 = 0x30;
const ISIG = 0x1, ICANON = 0x2, ECHO = 0x8, IEXTEN = 0x8000;
const VTIME = 5, VMIN = 6;
const TCSANOW = 0;

export const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGUSR1: 10, SIGUSR2: 12, SIGTERM: 15, SIGCONT: 18, SIGTSTP: 20, SIGWINCH: 28,
};
const SIGNAL_NAMES = Object.fromEntries(Object.entries(SIGNAL_NUMBERS).map(([name, signo]) => [signo, name]));

export interface NodeProcessOptions {
  env: Record<string, string>;
  argv: string[];
  /** `process.exit(code)` (called at most once). */
  exit(code: number): void;
}

export interface NodeProcess {
  process: any;
  /** Call after every `machine.pump()`: emits stdin data, resize and caught signals. */
  dispatch(): void;
}

export function createNodeProcess(machine: Machine, options: NodeProcessOptions): NodeProcess {
  const { pty } = machine;
  const encoder = new TextEncoder();
  const started = performance.now();
  const signals = machine.openSignalQueue(0xffff_fffe | 0);

  function size(): { cols: number; rows: number } {
    const view = new DataView(pty.getWinsize().buffer);
    return { rows: view.getUint16(0, true), cols: view.getUint16(2, true) };
  }

  let savedTermios: Uint8Array | undefined;
  function setRawMode(raw: boolean): void {
    if (!raw) {
      if (savedTermios) pty.setTermios(TCSANOW, savedTermios);
      savedTermios = undefined;
      return;
    }
    // What libuv's UV_TTY_MODE_RAW does (not cfmakeraw: OPOST stays on, so "\n" still becomes "\r\n").
    const termios = pty.getTermios();
    savedTermios ??= termios.slice();
    const view = new DataView(termios.buffer);
    view.setUint32(0, view.getUint32(0, true) & ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON), true);
    view.setUint32(8, view.getUint32(8, true) | CS8, true);
    view.setUint32(12, view.getUint32(12, true) & ~(ECHO | ICANON | IEXTEN | ISIG), true);
    termios[16 + VMIN] = 1;
    termios[16 + VTIME] = 0;
    pty.setTermios(TCSANOW, termios);
  }

  /** One read(2) on the pty slave, never blocking: null when nothing is available. */
  function readTty(): Uint8Array | null {
    if (!pty.pollIn()) return null;
    pty.slaveReadBegin();
    const chunk = pty.slaveRead(65536);
    return chunk instanceof Uint8Array ? chunk : null;
  }

  const stdin: any = new EventEmitter();
  // null: no consumer yet (data stays in the tty, as in Node); true: flowing; false: paused.
  let flowing: boolean | null = null;
  let ended = false;
  function drainStdin(): void {
    while (flowing && !ended) {
      const chunk = readTty();
      if (chunk === null) break;
      if (chunk.length === 0) {
        // EOF (^D on an empty line in canonical mode).
        ended = true;
        stdin.emit("end");
        break;
      }
      stdin.emit("data", Buffer.from(chunk));
    }
  }
  Object.assign(stdin, {
    fd: 0,
    isTTY: true,
    isRaw: false,
    readable: true,
    setRawMode(raw: boolean) {
      stdin.isRaw = raw;
      setRawMode(raw);
      return stdin;
    },
    setEncoding: () => stdin,
    resume() {
      flowing = true;
      queueMicrotask(drainStdin);
      return stdin;
    },
    pause() {
      flowing = false;
      return stdin;
    },
    read() {
      const chunk = readTty();
      return chunk === null || chunk.length === 0 ? null : Buffer.from(chunk);
    },
    ref: () => stdin,
    unref: () => stdin,
    destroy() {},
  });
  Object.defineProperty(stdin, "readableLength", { get: () => pty.readableLen() });
  stdin.on("newListener", (event: string) => {
    if (event === "data" && flowing === null) stdin.resume();
  });

  const output = (fd: number) => {
    const stream: any = new EventEmitter();
    Object.assign(stream, {
      fd,
      isTTY: true,
      writable: true,
      getWindowSize: () => [size().cols, size().rows],
      getColorDepth: () => 24,
      hasColors: () => true,
      write(chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) {
        pty.slaveWrite(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        // Blocks here when the page is more than OUT_WINDOW bytes behind: output flow control.
        machine.flushOutput();
        const done = typeof encoding === "function" ? encoding : callback;
        if (typeof done === "function") queueMicrotask(done as () => void);
        return true;
      },
      end() {},
      cork() {},
      uncork() {},
    });
    Object.defineProperties(stream, {
      columns: { get: () => size().cols },
      rows: { get: () => size().rows },
    });
    return stream;
  };
  const stdout = output(1);
  const stderr = output(2);

  const process: any = new EventEmitter();
  process.setMaxListeners(100);
  let cwd = options.env.PWD ?? "/";
  let exiting = false;
  Object.assign(process, {
    stdin,
    stdout,
    stderr,
    env: options.env,
    argv: options.argv,
    execArgv: [],
    execPath: "/usr/bin/wasm-term-js",
    pid: 1,
    ppid: 0,
    platform: "linux",
    arch: "wasm32",
    version: "v24.0.0",
    versions: { node: "24.0.0" },
    release: { name: "node" },
    title: "wasm-term",
    exitCode: undefined as number | undefined,
    browser: false,
    cwd: () => cwd,
    chdir(directory: string) {
      cwd = directory;
    },
    exit(code?: number) {
      if (exiting) return;
      exiting = true;
      const status = code ?? process.exitCode ?? 0;
      process.emit("exit", status);
      options.exit(status);
    },
    kill(_pid: number, signal: string | number = "SIGTERM") {
      try {
        machine.raise(typeof signal === "number" ? signal : SIGNAL_NUMBERS[signal] ?? 15);
      } catch (thrown) {
        if (!(thrown instanceof ProcessExit)) throw thrown;
        process.exit(thrown.code);
        return true;
      }
      dispatch();
      return true;
    },
    nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => callback(...args)),
    hrtime: Object.assign(
      (previous?: [number, number]) => {
        const now = performance.now();
        const seconds = Math.floor(now / 1000);
        const nanos = Math.floor((now % 1000) * 1e6);
        if (!previous) return [seconds, nanos];
        const diffNanos = nanos - previous[1];
        return diffNanos < 0 ? [seconds - previous[0] - 1, diffNanos + 1e9] : [seconds - previous[0], diffNanos];
      },
      { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) },
    ),
    uptime: () => (performance.now() - started) / 1000,
    memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
    cpuUsage: () => ({ user: 0, system: 0 }),
    emitWarning: (warning: unknown) => console.warn(warning),
    umask: () => 0o022,
    getuid: () => 1000,
    getgid: () => 1000,
    binding: () => ({}),
    features: {},
    config: { variables: {} },
    getBuiltinModule: () => undefined,
  });

  // A signal with a listener is caught; without one it takes its default action.
  // SIGWINCH is always caught: stdout's "resize" needs it.
  machine.setDisposition(SIGWINCH, SIG_CATCH);
  const disposition = (event: string | symbol, removing: boolean) => {
    const signo = typeof event === "string" ? SIGNAL_NUMBERS[event] : undefined;
    if (signo === undefined || signo === SIGWINCH || signo >= NSIG) return;
    const listeners = process.listenerCount(event) + (removing ? 0 : 1);
    machine.setDisposition(signo, listeners > 0 ? SIG_CATCH : SIG_DFL);
  };
  process.on("newListener", (event: string | symbol) => disposition(event, false));
  process.on("removeListener", (event: string | symbol) => disposition(event, true));

  function dispatch(): void {
    for (let signo = signals.pending.shift(); signo !== undefined; signo = signals.pending.shift()) {
      if (signo === SIGWINCH) {
        stdout.emit("resize");
        stderr.emit("resize");
      }
      const name = SIGNAL_NAMES[signo] ?? `SIG${signo}`;
      process.emit(name, name, signo);
    }
    drainStdin();
  }

  return { process, dispatch };
}
