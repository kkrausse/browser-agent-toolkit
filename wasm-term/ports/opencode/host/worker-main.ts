// Worker entry for a JS program on the wasm-term machine. It speaks the same
// page protocol as ../../host/worker.ts (InitMessage in, WorkerMessage out,
// inbound frames on the SharedArrayBuffer ring), so ../../host/index.ts's
// startProgram() can launch it by pointing `workerUrl` here.
//
// Unlike a wasm guest, a JS program never blocks: this entry runs an async
// pump that moves bytes between the ring, the kernel's pty and the program's
// process.stdin/stdout, and yields to the event loop in between.
import { loadKernel, type Pty } from "../../../host/kernel"
import {
  FRAME_INPUT, FRAME_RESIZE, FRAME_SIGNAL, H_WAKE, type InitMessage, type WorkerMessage,
} from "../../../host/protocol"
import { createRingReader } from "../../../host/ring"
import { bootOpentuiWasm } from "../src/boot"
import { createMachineProcess } from "../src/node/process"
import { installNodeTimers } from "../src/node/timers"
import { Buffer } from "node:buffer"

const post = (message: WorkerMessage, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage(message, transfer)

// termios flag bits (Linux values, as in kernel/src/termios.rs).
const BRKINT = 0x2, INPCK = 0x10, ISTRIP = 0x20, ICRNL = 0x100, IXON = 0x400
const CS8 = 0x30
const ISIG = 0x1, ICANON = 0x2, ECHO = 0x8, IEXTEN = 0x8000
const VTIME = 5, VMIN = 6
const TCSANOW = 0
const SIGNAL_NAMES: Record<number, string> = { 1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 15: "SIGTERM", 20: "SIGTSTP", 28: "SIGWINCH" }

async function run(init: InitMessage): Promise<void> {
  const kernel = await loadKernel(await WebAssembly.compileStreaming(fetch(init.kernelUrl)))
  const pty: Pty = kernel.createPty(init.cols, init.rows)
  pty.setWinsize(init.cols, init.rows, init.xpixel, init.ypixel)
  pty.takeSignals()
  const ring = createRingReader(init.sab)

  const flushToTerminal = () => {
    const bytes = pty.masterRead()
    if (bytes.length > 0) post({ t: "out", data: bytes.slice() })
  }
  let savedTermios: Uint8Array | undefined
  let exited = false
  const machine = createMachineProcess(
    {
      write(_fd, bytes) {
        pty.slaveWrite(bytes)
        flushToTerminal()
      },
      setRawMode(raw) {
        if (raw) {
          const termios = pty.getTermios().slice()
          savedTermios ??= termios.slice()
          const view = new DataView(termios.buffer)
          view.setUint32(0, view.getUint32(0, true) & ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON), true)
          view.setUint32(8, view.getUint32(8, true) | CS8, true)
          view.setUint32(12, view.getUint32(12, true) & ~(ECHO | ICANON | IEXTEN | ISIG), true)
          termios[16 + VMIN] = 1
          termios[16 + VTIME] = 0
          pty.setTermios(TCSANOW, termios)
        } else if (savedTermios) pty.setTermios(TCSANOW, savedTermios)
      },
      size() {
        const view = new DataView(pty.getWinsize().slice().buffer)
        return { rows: view.getUint16(0, true), cols: view.getUint16(2, true) }
      },
      exit(code) {
        if (exited) return
        exited = true
        flushToTerminal()
        post({ t: "exit", code })
      },
    },
    { ...init.env },
    init.args,
  )
  const globals = globalThis as Record<string, any>
  globals.process = machine.process
  globals.global = globalThis
  installNodeTimers()
  globals.Buffer ??= Buffer
  // Bun 1.4's browser polyfill of node:util references this binding without
  // defining it (ReferenceError at module evaluation); a global satisfies it.
  globals.kCustomPromisifiedSymbol = Symbol.for("nodejs.util.promisify.custom")
  // The two Bun globals the opencode TUI touches outside conditional imports
  // (migration-overlay.tsx: Bun.sleep; prompt/local-attachment.ts: Bun.file).
  globals.Bun = {
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    file: () => ({ exists: async () => false, size: 0 }),
  }
  const log = (level: string, message: string, tags?: unknown) =>
    post({ t: "log", text: `[opencode ${level}] ${message} ${tags === undefined ? "" : safeJson(tags)}` })
  self.addEventListener("unhandledrejection", (event) => {
    log("error", "unhandled rejection", String((event as PromiseRejectionEvent).reason?.stack ?? (event as PromiseRejectionEvent).reason))
  })

  // Inbound pump: ring -> line discipline -> process.stdin.
  const pump = () => {
    for (let frame = ring.next(); frame !== null; frame = ring.next()) {
      const type = frame.type & 0x7f
      if (type === FRAME_INPUT) pty.masterWrite(frame.payload)
      else if (type === FRAME_RESIZE) {
        const size = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength)
        pty.setWinsize(size.getUint16(0, true), size.getUint16(2, true), size.getUint16(4, true), size.getUint16(6, true))
      } else if (type === FRAME_SIGNAL) {
        const signo = new DataView(frame.payload.buffer, frame.payload.byteOffset, 4).getUint32(0, true)
        machine.process.emit(SIGNAL_NAMES[signo] ?? `SIG${signo}`)
      }
    }
    if (ring.writerWaiting()) post({ t: "drain" })
    flushToTerminal() // echo
    const signals = pty.takeSignals()
    if (signals & (1 << 28)) machine.resized()
    if (signals & (1 << 2)) machine.process.emit("SIGINT", "SIGINT")
    while (pty.pollIn()) {
      pty.slaveReadBegin()
      const chunk = pty.slaveRead(65536)
      if (!(chunk instanceof Uint8Array) || chunk.length === 0) break
      machine.pushInput(chunk.slice())
    }
  }
  const pumpForever = async () => {
    while (!exited) {
      const seen = Atomics.load(ring.header, H_WAKE)
      pump()
      const waiter = (Atomics as any).waitAsync?.(ring.header, H_WAKE, seen, 250)
      if (waiter?.async) await waiter.value
      else if (!waiter) await new Promise((resolve) => setTimeout(resolve, 8))
    }
  }
  void pumpForever()

  const wasm = await (await fetch(init.guestUrl)).arrayBuffer()
  await bootOpentuiWasm(wasm, { write: (fd, bytes) => machine.process[fd === 2 ? "stderr" : "stdout"].write(bytes) })

  const appUrl = init.env.WASM_TERM_APP_URL ?? "/opencode-tui.browser.js"
  const app = (await import(/* @vite-ignore */ appUrl)) as typeof import("./worker-app")
  try {
    await app.start({
      serverUrl: init.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4792",
      password: init.env.OPENCODE_SERVER_PASSWORD,
      prompt: init.env.OPENCODE_PROMPT,
      log,
    })
    machine.process.exit(0)
  } catch (error) {
    const text = error instanceof Error ? (error.stack ?? error.message) : String(error)
    machine.process.stderr.write(`\r\nwasm-term: opencode TUI failed: ${text.replaceAll("\n", "\r\n")}\r\n`)
    flushToTerminal()
    post({ t: "exit", code: 1, error: text })
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

self.addEventListener("message", (event) => {
  const message = (event as MessageEvent<InitMessage>).data
  if (message.t !== "init") return
  run(message).catch((thrown) => {
    console.error(thrown)
    post({ t: "exit", code: 127, error: thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown) })
  })
})
