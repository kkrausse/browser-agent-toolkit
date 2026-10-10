// The `process` object of a JS program running on the wasm-term machine:
// stdin/stdout/stderr are the slave side of the kernel's pty, setRawMode is
// tcsetattr, SIGWINCH comes from the pty's window size. Created by the worker
// entry and installed as globalThis.process before the app bundle evaluates;
// `node:process` (below) re-exports it.
import { EventEmitter } from "node:events"

export interface TtyHost {
  /** Program output: goes through the line discipline's output processing to the terminal. */
  write(fd: number, bytes: Uint8Array): void
  /** tcsetattr the way libuv's UV_TTY_MODE_RAW does, or restore the previous termios. */
  setRawMode(raw: boolean): void
  size(): { cols: number; rows: number }
  exit(code: number): void
}

export interface MachineProcess {
  process: any
  /** Bytes the line discipline released to the program (pty slave read). */
  pushInput(bytes: Uint8Array): void
  /** The pty's window size changed. */
  resized(): void
  /** True while the program has a "data" listener and has not paused stdin. */
  wantsInput(): boolean
}

export function createMachineProcess(host: TtyHost, env: Record<string, string>, argv: string[]): MachineProcess {
  const encoder = new TextEncoder()
  const started = performance.now()

  const stdin: any = new EventEmitter()
  let flowing = false
  const pending: Uint8Array[] = []
  Object.assign(stdin, {
    fd: 0,
    isTTY: true,
    isRaw: false,
    readable: true,
    setRawMode(raw: boolean) {
      stdin.isRaw = raw
      host.setRawMode(raw)
      return stdin
    },
    setEncoding: () => stdin,
    resume() {
      flowing = true
      while (flowing && pending.length > 0) stdin.emit("data", Buffer.from(pending.shift()!))
      return stdin
    },
    pause() {
      flowing = false
      return stdin
    },
    read() {
      const chunk = pending.shift()
      return chunk === undefined ? null : Buffer.from(chunk)
    },
    ref: () => stdin,
    unref: () => stdin,
    destroy() {},
  })

  // Live values must be accessors: Object.assign would copy a getter's current value.
  Object.defineProperty(stdin, "readableLength", {
    get: () => pending.reduce((total, chunk) => total + chunk.byteLength, 0),
  })

  const output = (fd: number) => {
    const stream: any = new EventEmitter()
    Object.assign(stream, {
      fd,
      isTTY: true,
      writable: true,
      getWindowSize: () => [host.size().cols, host.size().rows],
      getColorDepth: () => 24,
      hasColors: () => true,
      write(chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) {
        host.write(fd, typeof chunk === "string" ? encoder.encode(chunk) : chunk)
        const done = typeof encoding === "function" ? encoding : callback
        if (typeof done === "function") queueMicrotask(done as () => void)
        return true
      },
      end() {},
      cork() {},
      uncork() {},
    })
    Object.defineProperties(stream, {
      columns: { get: () => host.size().cols },
      rows: { get: () => host.size().rows },
    })
    return stream
  }
  const stdout = output(1)
  const stderr = output(2)

  const process: any = new EventEmitter()
  process.setMaxListeners(100)
  let cwd = env.PWD ?? "/"
  Object.assign(process, {
    stdin,
    stdout,
    stderr,
    env,
    argv,
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
      cwd = directory
    },
    exit(code?: number) {
      process.emit("exit", code ?? process.exitCode ?? 0)
      host.exit(code ?? process.exitCode ?? 0)
    },
    kill(_pid: number, signal: string | number = "SIGTERM") {
      process.emit(typeof signal === "string" ? signal : `SIG${signal}`)
      return true
    },
    nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => callback(...args)),
    hrtime: Object.assign(
      (previous?: [number, number]) => {
        const now = performance.now()
        const seconds = Math.floor(now / 1000)
        const nanos = Math.floor((now % 1000) * 1e6)
        if (!previous) return [seconds, nanos]
        const diffNanos = nanos - previous[1]
        return diffNanos < 0 ? [seconds - previous[0] - 1, diffNanos + 1e9] : [seconds - previous[0], diffNanos]
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
  })

  return {
    process,
    pushInput(bytes) {
      if (flowing && stdin.listenerCount("data") > 0) stdin.emit("data", Buffer.from(bytes))
      else pending.push(bytes)
    },
    resized() {
      stdout.emit("resize")
      stderr.emit("resize")
      process.emit("SIGWINCH", "SIGWINCH")
    },
    wantsInput: () => flowing,
  }
}
