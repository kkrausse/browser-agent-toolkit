// The guest's /bin/sh: crates/bat-sh compiled to Wasm (`bat_sh.wasm`, config
// name `sh`), with its host calls mapped onto this process's kernel binding.
//
// The shell keeps its own variables, working directory and descriptor table
// and runs its builtins (the coreutils included) as function calls, so it does
// not have to be a kernel process. Two callers:
//
//   - child_process, for the synchronous calls (`execSync`, `spawnSync` of a
//     shell): the shell runs right here in the calling worker, output captured
//     in its memory. No process, no worker.
//   - the process worker, when a process's executable is `/bin/sh` (async
//     `exec`/`spawn`): the same module run against descriptors 0..2.
//
// Children the shell starts (`node`, JavaScript programs) are ordinary kernel
// processes of the calling process.
import type { Runtime } from './runtime'

/** Executable name the kernel is given for a shell process; the process worker recognises it. */
export const SHELL_EXEC = '/bin/sh'
export const SHELL_NAMES = ['sh', 'bash', 'zsh', 'dash', 'ash']
/** Commands the shell implements itself and that can be run as programs (crates/bat-sh/src/builtins.rs, BUILTINS minus the shell-only ones). */
export const SHELL_PROGRAMS = new Set(
  '[ basename cat chmod cp cut date dirname du echo env false find grep egrep fgrep head hostname id ln ls mkdir mktemp mv printenv printf pwd readlink realpath rm rmdir sed seq sleep sort tail tee test touch tr true uname uniq wc which whoami xargs npm npx bunx yarn pnpm bun nproc stat rev tac'.split(
    ' ',
  ),
)
/** Paths that exist as (stub) files so that `existsSync('/bin/bash')` and shebang lines find them. */
export const SHELL_STUBS = ['/bin/sh', '/bin/bash', '/usr/bin/env']

export interface ShellRequest {
  /** `['sh', '-c', '…']`, `['bash', 'script.sh']`, or a command by itself: `['ls', '-la']`. */
  argv: string[]
  env: Record<string, string>
  cwd: string
  /** Per descriptor 0..2: a kernel fd of this process, 'null', or 'memory' (stdin: `input`; stdout/stderr: returned). */
  stdio: [number | 'null' | 'memory', number | 'null' | 'memory', number | 'null' | 'memory']
  input?: Uint8Array
  /** Children are killed and the run ends once this much time has passed (checked while waiting for a child or sleeping). */
  timeoutMs?: number
  /** The shell is the process: take the process's signals, pass them to the running child, end with 128 + signal. */
  asProcess?: boolean
}

export interface ShellResult {
  status: number
  stdout: Uint8Array
  stderr: Uint8Array
  timedOut: boolean
  /** Signal that ended the run (asProcess), 0 if none. */
  signal: number
}

export interface Shell {
  run(req: ShellRequest): ShellResult
}

interface Exports {
  memory: WebAssembly.Memory
  sh_alloc(n: number): number
  sh_free(p: number, n: number): void
  sh_run(p: number, n: number): number
  sh_out_ptr(which: number): number
  sh_out_len(which: number): number
}

/** Thrown through the Wasm frames to end a run that was signalled or timed out. */
const ABORT = Symbol('sh.abort')

export function createShell(rt: Runtime): Shell {
  const k = rt.kernel
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let x: Exports | undefined
  let stash: Uint8Array = new Uint8Array(0)
  // State of the run in progress.
  let deadline = Infinity
  let timedOut = false
  let asProcess = false
  let signal = 0
  const sleeper = new Int32Array(new SharedArrayBuffer(4))

  const mem = () => new Uint8Array(x!.memory.buffer)
  const str = (p: number, n: number) => decoder.decode(new Uint8Array(x!.memory.buffer, p, n))
  const call = (fn: () => number | void): number => {
    try {
      return fn() ?? 0
    } catch (e: any) {
      if (e === ABORT) throw e
      return -(e?.errno > 0 ? e.errno : 5)
    }
  }
  /** Children started in this run and not yet waited for. */
  const running = new Set<number>()
  const abort = (): never => {
    for (const pid of running) {
      try {
        k.kill(pid, signal || 15)
      } catch {
        // already gone
      }
    }
    running.clear()
    throw ABORT
  }
  const keep = (bytes: Uint8Array): number => {
    stash = bytes
    return bytes.length
  }
  /** Signals taken since the last look (process mode). The first one ends the run. */
  const interrupted = (): boolean => {
    if (asProcess && !signal) {
      const mask = k.sigTake()
      if (mask) for (let s = 1; s < 32; s++) if (mask & (1 << s)) signal ||= s
    }
    if (performance.now() > deadline) timedOut = true
    return signal !== 0 || timedOut
  }

  const imports = {
    sh_open: (p: number, n: number, flags: number, mode: number) => call(() => k.open(str(p, n), flags, mode)),
    sh_close: (fd: number) => call(() => k.close(fd)),
    sh_read: (fd: number, p: number, n: number) =>
      call(() => {
        const got = k.read(fd, new Uint8Array(x!.memory.buffer, p, n))
        if (asProcess && interrupted()) abort()
        return got
      }),
    sh_write: (fd: number, p: number, n: number) =>
      call(() => {
        if (asProcess && interrupted()) abort()
        return k.write(fd, new Uint8Array(x!.memory.buffer, p, n))
      }),
    sh_stat: (p: number, n: number, follow: number, out: number) =>
      call(() => {
        const st = k.stat(str(p, n), !follow)
        new Float64Array(x!.memory.buffer, out, 4).set([st.kind, st.mode & 0o7777, st.size, st.mtimeMs])
      }),
    sh_readdir: (p: number, n: number) =>
      call(() =>
        keep(
          encoder.encode(
            k
              .readdir(str(p, n))
              .map((e) => `${e.kind}${e.name}`)
              .join('\0'),
          ),
        ),
      ),
    sh_readlink: (p: number, n: number) => call(() => keep(encoder.encode(k.readlink(str(p, n))))),
    sh_realpath: (p: number, n: number) => call(() => keep(encoder.encode(k.realpath(str(p, n))))),
    sh_take: (p: number, cap: number) => {
      mem().set(stash.subarray(0, cap), p)
    },
    sh_mkdir: (p: number, n: number, mode: number) => call(() => k.mkdir(str(p, n), { mode })),
    sh_rmdir: (p: number, n: number) => call(() => k.rmdir(str(p, n))),
    sh_unlink: (p: number, n: number) => call(() => k.unlink(str(p, n))),
    sh_rename: (p: number, n: number, q: number, m: number) => call(() => k.rename(str(p, n), str(q, m))),
    sh_symlink: (p: number, n: number, q: number, m: number) => call(() => k.symlink(str(p, n), str(q, m))),
    sh_chmod: (p: number, n: number, mode: number) => call(() => k.chmod(str(p, n), mode)),
    sh_utimes: (p: number, n: number, ms: number) => call(() => k.utimes(str(p, n), ms)),
    sh_pipe: (out: number) =>
      call(() => {
        const [r, w] = k.pipe()
        new Int32Array(x!.memory.buffer, out, 2).set([r, w])
      }),
    sh_spawn: (p: number, n: number) =>
      call(() => {
        if (interrupted()) abort()
        const dv = new DataView(x!.memory.buffer, p, n)
        let o = 0
        const i32 = () => {
          const v = dv.getInt32(o, true)
          o += 4
          return v
        }
        const text = () => {
          const len = i32()
          const s = str(p + o, len)
          o += len
          return s
        }
        const fds = [i32(), i32(), i32()]
        const argc = i32()
        const envc = i32()
        const exec = text()
        const cwd = text()
        const argv = Array.from({ length: argc }, text)
        const env: Record<string, string> = {}
        for (let i = 0; i < envc; i++) {
          const kv = text()
          const eq = kv.indexOf('=')
          if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1)
        }
        delete env.NODE_CHANNEL_FD
        const pid = k.spawn({ exec, argv, env, cwd, stdio: fds.map((fd) => (fd < 0 ? 'null' : { fd })) as any }).pid
        running.add(pid)
        return pid
      }),
    sh_wait: (pid: number): number => {
      running.delete(pid)
      if (!asProcess && deadline === Infinity) {
        try {
          return k.waitpid(pid) ?? 127
        } catch {
          return 127
        }
      }
      const word = k.x.bat_event_word() >>> 2
      let killedAt = 0
      for (;;) {
        const i32 = k.inst.i32()
        const seen = Atomics.load(i32, word)
        let st: number | undefined
        try {
          st = k.waitpid(pid, true)
        } catch {
          st = 127
        }
        if (st !== undefined) {
          // The signal that ended the child may have been meant for the shell as well.
          if (killedAt || interrupted()) abort()
          return st
        }
        if (interrupted()) {
          const now = performance.now()
          try {
            if (!killedAt) k.kill(pid, signal || 15)
            else if (now - killedAt > 2000) k.kill(pid, 9)
          } catch {
            // already gone
          }
          killedAt ||= now
        }
        Atomics.wait(i32, word, seen, killedAt ? 50 : Math.max(1, Math.min(deadline - performance.now(), 1000)))
      }
    },
    sh_kill: (pid: number, sig: number) => call(() => k.kill(pid, sig)),
    sh_now: () => Date.now(),
    sh_sleep: (ms: number) => {
      const until = performance.now() + ms
      for (;;) {
        const left = until - performance.now()
        if (interrupted()) abort()
        if (left <= 0) return
        Atomics.wait(sleeper, 0, 0, Math.min(left, asProcess || deadline !== Infinity ? 50 : left))
      }
    },
    sh_tz: () => -new Date().getTimezoneOffset(),
    sh_pid: () => k.getpid(),
  }

  const instance = (): Exports => (x ??= new WebAssembly.Instance(rt.wasmModule('sh'), { sh: imports }).exports as unknown as Exports)

  function run(req: ShellRequest): ShellResult {
    const sh = instance()
    deadline = req.timeoutMs && req.timeoutMs > 0 ? performance.now() + req.timeoutMs : Infinity
    timedOut = false
    asProcess = !!req.asProcess
    signal = 0
    running.clear()
    const strings = [req.cwd, ...req.argv, ...Object.entries(req.env).map(([key, v]) => `${key}=${v}`)].map((s) => encoder.encode(s))
    const input = req.stdio[0] === 'memory' ? (req.input ?? new Uint8Array(0)) : new Uint8Array(0)
    const size = 20 + strings.reduce((n, s) => n + 4 + s.length, 0) + 4 + input.length
    const p = sh.sh_alloc(size)
    const dv = new DataView(sh.memory.buffer, p, size)
    const u8 = mem()
    let o = 0
    for (const s of req.stdio) {
      dv.setInt32(o, s === 'null' ? -1 : s === 'memory' ? -2 : s, true)
      o += 4
    }
    dv.setUint32(o, req.argv.length, true)
    dv.setUint32(o + 4, Object.keys(req.env).length, true)
    o += 8
    for (const s of [...strings, input]) {
      dv.setUint32(o, s.length, true)
      u8.set(s, p + o + 4)
      o += 4 + s.length
    }
    let status: number
    try {
      status = sh.sh_run(p, size)
    } catch (e) {
      // Ended from outside (signal, timeout) or a trap (the build aborts on panic): either way the
      // instance was left in the middle of a run, so the next run gets a new one.
      x = undefined
      if (e === ABORT) return { status: signal ? 128 + signal : 124, stdout: new Uint8Array(0), stderr: new Uint8Array(0), timedOut, signal }
      const text = encoder.encode(`sh: internal error: ${(e as Error)?.message ?? e}\n`)
      if (typeof req.stdio[2] === 'number') {
        try {
          k.write(req.stdio[2], text)
        } catch {
          // nowhere to say it
        }
      }
      return { status: 134, stdout: new Uint8Array(0), stderr: req.stdio[2] === 'memory' ? text : new Uint8Array(0), timedOut, signal }
    }
    const out = (which: number) => {
      const len = sh.sh_out_len(which)
      return len ? new Uint8Array(sh.memory.buffer, sh.sh_out_ptr(which), len).slice() : new Uint8Array(0)
    }
    const result: ShellResult = { status, stdout: out(0), stderr: out(1), timedOut, signal }
    sh.sh_free(p, size)
    return result
  }

  return { run }
}

/** What to run for `file` if it is the shell, one of its commands, or a conventional path of either; undefined otherwise. */
export function shellArgv(file: string, args: string[]): string[] | undefined {
  const slash = file.lastIndexOf('/')
  const base = file.slice(slash + 1)
  const conventional = slash < 0 || /^\/(usr\/(local\/)?)?bin$/.test(file.slice(0, slash))
  if (!conventional) return undefined
  if (SHELL_NAMES.includes(base) || SHELL_PROGRAMS.has(base)) return [base, ...args]
  return undefined
}
