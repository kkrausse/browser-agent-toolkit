// A wasm-term guest's child processes (`proc_*`, wasm-term/docs/abi.md 3.4) as
// processes of the toolkit's kernel.
//
// wasm-term's own table (wasm-term/host/proc.ts) runs each command in a shell
// Worker whose file calls are carried back to the guest's Worker, because that
// Worker owns the files. Here the files are the kernel's, so a command is an
// ordinary kernel process: `/bin/sh` (the same bat-sh module, started by
// kerneld in a process worker, runtime/src/process/sh.ts) with three pipes.
// What that adds is everything the kernel can run: the shell starts `node`,
// and with it the app's own scripts (`npx tsc`, `node script.mjs`), as real
// processes on the files codex edits.
//
// The guest's Worker is blocked in Atomics.wait on wasm-term's ring whenever
// it waits, and a kernel pipe cannot wake that address. So while a child is
// alive the wait is cut into POLL_MS slices and the pipes are read without
// blocking in each. Output is at most that late; nothing is lost and nothing
// spins when no child runs.
import type { Kernel } from '../../../runtime/src/kernel/kernel'
import type { Machine } from '../../../wasm-term/host/machine'
import { EXIT_BYTES, PROC_EXIT, PROC_STDERR, PROC_STDOUT, type Proc, type ProcEvent, type Processes } from '../../../wasm-term/host/proc'

const POLL_MS = 3
const EAGAIN = 11
/** Output queued for the guest beyond which a child's pipes are left unread (the kernel pipe then fills and the child waits). */
const OUT_WINDOW = 1 << 20
const MERGE_BYTES = 64 * 1024
const READ_BYTES = 64 * 1024
/** After the shell has exited, how long its pipes are still read for output of a descendant that holds them open. */
const LINGER_MS = 100
const WASI = { SUCCESS: 0, INVAL: 28, PIPE: 64 }

interface Child {
  pid: number
  stdin: number
  out: [number, number]
  status: number | undefined
  exitedAt: number
  killSignal: number
}

export interface KernelProcessOptions {
  kernel: Kernel
  machine: Machine
  /** Where a command runs when the directory the guest names does not exist in the kernel (the guest's home, say). */
  fallbackCwd: string
  /** Added to every command's environment (after the guest's own): `PATH`. */
  env: Record<string, string>
}

export function createKernelProcesses({ kernel: k, machine, fallbackCwd, env: extraEnv }: KernelProcessOptions): Processes {
  const decoder = new TextDecoder()
  const live = new Map<Proc, Child>()
  const buffer = new Uint8Array(READ_BYTES)

  function decode(body: Uint8Array): { argv: string[]; env: Record<string, string>; cwd: string } | null {
    try {
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
      const argc = view.getUint32(0, true)
      const envc = view.getUint32(4, true)
      if (argc === 0 || argc > 65536 || envc > 65536) return null
      let at = 8
      const text = () => {
        const length = view.getUint32(at, true)
        if (at + 4 + length > body.length) throw new RangeError('short request')
        const value = decoder.decode(body.slice(at + 4, at + 4 + length))
        at += 4 + length
        return value
      }
      const cwd = text()
      const argv = Array.from({ length: argc }, text)
      const env: Record<string, string> = {}
      for (let index = 0; index < envc; index++) {
        const pair = text()
        const equals = pair.indexOf('=')
        if (equals > 0) env[pair.slice(0, equals)] = pair.slice(equals + 1)
      }
      return { argv, env, cwd }
    } catch {
      return null
    }
  }

  function push(proc: Proc, kind: number, data: Uint8Array): void {
    const last = proc.events[proc.events.length - 1]
    if (last && last.kind === kind && last.data.length + data.length <= MERGE_BYTES) {
      const merged = new Uint8Array(last.data.length + data.length)
      merged.set(last.data)
      merged.set(data, last.data.length)
      last.data = merged
    } else proc.events.push({ kind, data })
    proc.queued += data.length
  }

  const closeFd = (fd: number) => {
    if (fd < 0) return
    try {
      k.close(fd)
    } catch {
      // closed already
    }
  }

  function finish(proc: Proc, child: Child): void {
    if (proc.done) return
    proc.done = true
    live.delete(proc)
    closeFd(child.stdin)
    closeFd(child.out[0])
    closeFd(child.out[1])
    child.stdin = child.out[0] = child.out[1] = -1
    const now = performance.now()
    const raw = child.status ?? 137
    // The kernel reports a death by signal as 128 + signal, like a shell does.
    const signal = child.killSignal && raw === 128 + child.killSignal ? child.killSignal : 0
    const exit = new Uint8Array(EXIT_BYTES)
    const view = new DataView(exit.buffer)
    view.setInt32(0, raw, true)
    view.setInt32(4, signal, true)
    view.setUint32(8, 0, true)
    view.setUint32(12, Math.max(0, Math.round((now - proc.spawnedAt) * 1000)), true)
    view.setUint32(16, 0, true)
    proc.events.push({ kind: PROC_EXIT, data: exit })
    proc.stdinOpen = false
    proc.stdin.length = 0
    machine.post({ t: 'proc_stat', command: proc.command, status: raw, signal, calls: 0, queueMs: 0, runMs: now - proc.spawnedAt })
  }

  /** Moves what there is: queued stdin in, output out, the exit status. */
  function service(proc: Proc, child: Child): void {
    while (child.stdin >= 0 && proc.stdin.length > 0) {
      const chunk = proc.stdin[0]!
      const wrote = k.writeRaw(child.stdin, chunk)
      if (wrote === -EAGAIN) break
      if (wrote < 0) {
        // The child closed its end or is gone.
        proc.stdin.length = 0
        proc.stdinOpen = false
        break
      }
      if (wrote >= chunk.length) proc.stdin.shift()
      else proc.stdin[0] = chunk.subarray(wrote)
    }
    if (child.stdin >= 0 && proc.stdin.length === 0 && !proc.stdinOpen) {
      closeFd(child.stdin)
      child.stdin = -1
    }
    for (const index of [0, 1] as const) {
      while (child.out[index] >= 0 && proc.queued <= OUT_WINDOW) {
        const got = k.readRaw(child.out[index], buffer)
        if (got === -EAGAIN) break
        if (got <= 0) {
          closeFd(child.out[index])
          child.out[index] = -1
          break
        }
        push(proc, index === 0 ? PROC_STDOUT : PROC_STDERR, buffer.slice(0, got))
      }
    }
    if (child.status === undefined) {
      try {
        child.status = k.waitpid(child.pid, true)
      } catch {
        child.status = 127 // reaped by someone else: cannot happen for our own child, but do not wait forever
      }
      if (child.status !== undefined) child.exitedAt = performance.now()
    }
    if (child.status !== undefined && proc.queued <= OUT_WINDOW) {
      const drained = child.out[0] < 0 && child.out[1] < 0
      if (drained || performance.now() - child.exitedAt > LINGER_MS) finish(proc, child)
    }
  }

  /** The process and everything below it: the shell passes INT and TERM to its children itself; KILL goes to each. */
  function kill(child: Child, signo: number): void {
    child.killSignal ||= signo
    const pids = [child.pid]
    if (signo === 9) {
      const all = k.procList()
      for (let index = 0; index < pids.length; index++) for (const entry of all) if (entry.ppid === pids[index] && entry.state !== 2) pids.push(entry.pid)
    }
    for (const pid of pids.reverse()) {
      try {
        k.kill(pid, signo)
      } catch {
        // gone already
      }
    }
  }

  machine.addWakeSource({
    serve() {
      for (const [proc, child] of live) service(proc, child)
    },
    pending: () => false,
    deadline: () => (live.size > 0 ? performance.now() + POLL_MS : Infinity),
  })

  return {
    spawn(request, flags) {
      const decoded = decode(request)
      if (!decoded) return WASI.INVAL
      const [, ...rest] = decoded.argv
      const cwd = k.kindOf(decoded.cwd) === 1 ? decoded.cwd : fallbackCwd
      const proc = {
        events: [] as ProcEvent[], queued: 0, stdin: [] as Uint8Array[], stdinOpen: (flags & 1) !== 0, slot: -1,
        spawnedAt: performance.now(), startedAt: 0, killAt: 0, killSignal: 0, done: false, waitingFor: 0,
        command: decoded.argv.join(' ').slice(0, 300),
      } as unknown as Proc
      try {
        // argv[0] is a path in the guest's own tree (`/bin/bash`); the kernel's shell goes by name.
        const spawned = k.spawn({
          exec: '/bin/sh', argv: ['bash', ...rest], cwd, env: { ...decoded.env, ...extraEnv, PWD: cwd },
          stdio: [flags & 1 ? 'pipe' : 'null', 'pipe', 'pipe'],
        })
        const [stdin, stdout, stderr] = spawned.stdio
        for (const fd of [stdin, stdout, stderr]) if (fd >= 0) k.setNonblock(fd, true)
        live.set(proc, { pid: spawned.pid, stdin, out: [stdout, stderr], status: undefined, exitedAt: 0, killSignal: 0 })
      } catch (error) {
        machine.lastError = `proc_spawn: the kernel could not start a shell: ${(error as Error)?.message ?? error}`
        push(proc, PROC_STDERR, new TextEncoder().encode(`${machine.lastError}\n`))
        finish(proc, { pid: 0, stdin: -1, out: [-1, -1], status: 126, exitedAt: performance.now(), killSignal: 0 })
      }
      return proc
    },
    take(proc, fits) {
      const event = proc.events[0]
      if (!event || !fits(event)) return undefined
      proc.events.shift()
      if (event.kind !== PROC_EXIT) proc.queued -= event.data.length
      return event
    },
    send(proc, data, close) {
      if (proc.done || !proc.stdinOpen) return WASI.PIPE
      if (data.length > 0) proc.stdin.push(data)
      if (close) proc.stdinOpen = false
      return WASI.SUCCESS
    },
    signal(proc, signo) {
      if (signo !== 2 && signo !== 9 && signo !== 15) return WASI.INVAL
      const child = live.get(proc)
      if (child) kill(child, signo)
      return WASI.SUCCESS
    },
    close(proc) {
      const child = live.get(proc)
      if (child) {
        kill(child, 9)
        child.status ??= 137
        finish(proc, child)
      }
      proc.events.length = 0
      proc.queued = 0
    },
  }
}
