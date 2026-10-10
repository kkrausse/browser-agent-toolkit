// `node:child_process`. A child is a new kernel process, which kerneld runs in
// a process worker (the warm spare when there is one). What can be executed:
// `node` / `process.execPath` with a script, a JavaScript file, a file with a
// node shebang, or a `.bin` shim that links to one. There is no shell: a
// command line is split into words and run as one command. Anything else
// fails with ENOENT, as a missing program does on Linux.
import { POLLHUP, POLLIN, POLLOUT, type StdioSpec } from '../kernel/kernel'
import type { Runtime } from '../process/runtime'
import { SIGNALS, SIGNAL_NAMES } from './process'
import { registerBuiltin } from './registry'

interface Command {
  exec: string
  argv: string[]
  env?: Record<string, string>
}

function create(rt: Runtime): any {
  const k = rt.kernel
  const loop = rt.loop
  const EventEmitter = rt.require('events')
  const Buffer = rt.require('buffer').Buffer
  const proc = rt.process
  const decoder = new TextDecoder()

  const enoent = (file: string, args: string[], syscall = 'spawn') =>
    Object.assign(new Error(`${syscall} ${file} ENOENT`), { errno: -2, code: 'ENOENT', syscall: `${syscall} ${file}`, path: file, spawnargs: args })

  /** Split a command line into words: quotes, backslash escapes, `VAR=value` prefixes, `$VAR` expansion. */
  function splitCommand(line: string, env: Record<string, string>): { words: string[]; env: Record<string, string> } | undefined {
    const words: string[] = []
    let cur = ''
    let has = false
    let quote = ''
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (quote) {
        if (c === quote) quote = ''
        else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i]
        else if (c === '$' && quote === '"') {
          const m = /^\$\{?(\w+)\}?/.exec(line.slice(i))
          if (m) {
            cur += env[m[1]] ?? ''
            i += m[0].length - 1
          } else cur += c
        } else cur += c
      } else if (c === '"' || c === "'") {
        quote = c
        has = true
      } else if (c === '\\' && i + 1 < line.length) {
        cur += line[++i]
        has = true
      } else if (c === ' ' || c === '\t' || c === '\n') {
        if (has || cur) words.push(cur)
        cur = ''
        has = false
      } else if (c === '$') {
        const m = /^\$\{?(\w+)\}?/.exec(line.slice(i))
        if (m) {
          cur += env[m[1]] ?? ''
          i += m[0].length - 1
        } else cur += c
      } else if ('|&;<>()`'.includes(c)) {
        return undefined // needs a real shell
      } else cur += c
    }
    if (quote) return undefined
    if (has || cur) words.push(cur)
    const extra: Record<string, string> = {}
    while (words.length && /^\w+=/.test(words[0])) {
      const w = words.shift()!
      extra[w.slice(0, w.indexOf('='))] = w.slice(w.indexOf('=') + 1)
    }
    return { words, env: extra }
  }

  const isNode = (file: string) => file === proc.execPath || file === 'node' || file === 'nodejs' || file.endsWith('/node')

  /** Find what to run for `file`. undefined = no such program. */
  function resolveCommand(file: string, args: string[], env: Record<string, string>, cwd: string): Command | undefined {
    if (isNode(file)) return { exec: 'node', argv: ['node', ...args] }
    const base = file.slice(file.lastIndexOf('/') + 1)
    if (base === 'sh' || base === 'bash' || base === 'zsh') {
      const i = args.indexOf('-c')
      if (i < 0 || i + 1 >= args.length) return undefined
      const parsed = splitCommand(args[i + 1], env)
      if (!parsed || parsed.words.length === 0) return undefined
      const inner = resolveCommand(parsed.words[0], parsed.words.slice(1), { ...env, ...parsed.env }, cwd)
      return inner && { ...inner, env: { ...inner.env, ...parsed.env } }
    }
    if (base === 'env' && args.length) {
      const extra: Record<string, string> = {}
      let i = 0
      while (i < args.length && /^\w+=/.test(args[i])) {
        extra[args[i].slice(0, args[i].indexOf('='))] = args[i].slice(args[i].indexOf('=') + 1)
        i++
      }
      if (i >= args.length) return undefined
      const inner = resolveCommand(args[i], args.slice(i + 1), { ...env, ...extra }, cwd)
      return inner && { ...inner, env: { ...inner.env, ...extra } }
    }
    const candidates: string[] = []
    if (file.includes('/')) candidates.push(file.startsWith('/') ? file : `${cwd}/${file}`)
    else for (const dir of (env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':')) if (dir) candidates.push(`${dir.startsWith('/') ? dir : `${cwd}/${dir}`}/${file}`)
    for (const path of candidates) {
      if (k.kindOf(path) !== 0) continue
      let real: string
      try {
        real = k.realpath(path)
      } catch {
        continue
      }
      if (/\.[cm]?js$/.test(real)) return { exec: real, argv: [file, ...args] }
      // A shebang names the interpreter.
      let head = ''
      try {
        const fd = k.open(real)
        const buf = new Uint8Array(256)
        const n = k.read(fd, buf, 0)
        k.close(fd)
        head = decoder.decode(buf.subarray(0, n))
      } catch {
        continue
      }
      const m = /^#!\s*(\S+)(?:\s+(.*))?/.exec(head.split('\n', 1)[0])
      if (m) {
        const interp = m[1].endsWith('/env') ? (m[2] ?? '').trim().split(/\s+/).filter((w) => !w.startsWith('-'))[0] ?? '' : m[1]
        if (isNode(interp) || interp === 'bun') return { exec: real, argv: [file, ...args] }
      }
      // Present but not something this runtime can execute (a native binary, a shell script).
      return undefined
    }
    return undefined
  }

  function normalizeStdio(stdio: any): { specs: [StdioSpec, StdioSpec, StdioSpec]; ipc: boolean } {
    const list: any[] = typeof stdio === 'string' ? [stdio, stdio, stdio] : Array.isArray(stdio) ? stdio.slice() : ['pipe', 'pipe', 'pipe']
    let ipc = false
    const specs = [0, 1, 2].map((i): StdioSpec => {
      const s = list[i] ?? 'pipe'
      if (s === 'pipe' || s === 'overlapped') return 'pipe'
      if (s === 'ignore') return 'null'
      if (s === 'inherit') return 'inherit'
      if (typeof s === 'number') return s === i ? 'inherit' : { fd: s }
      if (s && typeof s.fd === 'number') return s.fd === i ? 'inherit' : { fd: s.fd }
      if (s && typeof s._handle?.fd === 'number') return { fd: s._handle.fd }
      return 'pipe'
    }) as [StdioSpec, StdioSpec, StdioSpec]
    if (list.includes('ipc')) ipc = true
    return { specs, ipc }
  }

  function envOf(options: any, extra?: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, v] of Object.entries(options?.env ?? proc.env)) if (v !== undefined) out[key] = String(v)
    return extra ? { ...out, ...extra } : out
  }
  const cwdOf = (options: any): string => {
    const c = options?.cwd
    if (c === undefined || c === null) return proc.cwd()
    const s = c instanceof URL ? decodeURIComponent(c.pathname) : String(c)
    return s.startsWith('/') ? s : `${proc.cwd()}/${s}`
  }

  // ---- IPC: newline-delimited JSON over a loopback socket the child connects to ----
  function attachIpc(target: any, fd: number, onClose: () => void) {
    const { Buffer: B } = rt.require('buffer')
    let pending = ''
    const buf = new Uint8Array(65536)
    const utf8 = new TextDecoder()
    let open = true
    k.setNonblock(fd, true)
    let refed = false
    const ref = () => {
      if (!refed && open) {
        refed = true
        loop.ref()
      }
    }
    const unref = () => {
      if (refed) {
        refed = false
        loop.unref()
      }
    }
    const close = () => {
      if (!open) return
      open = false
      loop.offFd(fd)
      unref()
      try {
        k.close(fd)
      } catch {
        // already closed
      }
      target.connected = false
      onClose()
      target.emit('disconnect')
    }
    loop.onFd(fd, POLLIN | POLLHUP, () => {
      for (;;) {
        const n = k.readRaw(fd, buf)
        if (n === -11) return
        if (n <= 0) return close()
        pending += utf8.decode(buf.subarray(0, n), { stream: true })
        let i
        while ((i = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, i)
          pending = pending.slice(i + 1)
          let message
          try {
            message = JSON.parse(line)
          } catch {
            continue
          }
          target.emit('message', message, undefined)
        }
      }
    })
    target.connected = true
    target.send = (message: unknown, _handle?: unknown, options?: unknown, cb?: unknown) => {
      const done = [_handle, options, cb].find((x) => typeof x === 'function') as ((e: Error | null) => void) | undefined
      if (!open) {
        const e = Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' })
        if (done) loop.nextTick(done, e)
        else target.emit('error', e)
        return false
      }
      const bytes = B.from(`${JSON.stringify(message)}\n`)
      k.setNonblock(fd, false)
      try {
        let off = 0
        while (off < bytes.length) off += k.write(fd, off ? bytes.subarray(off) : bytes)
      } catch (e) {
        close()
        if (done) loop.nextTick(done, e as Error)
        return false
      } finally {
        if (open) k.setNonblock(fd, true)
      }
      if (done) loop.nextTick(done, null)
      return true
    }
    target.disconnect = close
    return { ref, unref, close }
  }

  class ChildProcess extends EventEmitter {
    pid: number | undefined
    stdin: any = null
    stdout: any = null
    stderr: any = null
    stdio: any[] = [null, null, null]
    exitCode: number | null = null
    signalCode: string | null = null
    killed = false
    connected = false
    spawnfile = ''
    spawnargs: string[] = []
    #refed = false
    #open = 0
    #exited = false

    _spawn(file: string, args: string[], options: any) {
      this.spawnfile = file
      this.spawnargs = [file, ...args]
      const env = envOf(options)
      const cwd = cwdOf(options)
      const { specs, ipc } = normalizeStdio(options?.stdio)
      const command = resolveCommand(file, args, env, cwd)
      if (!command || k.kindOf(cwd) !== 1) {
        loop.nextTick(() => this.emit('error', enoent(file, args)))
        return this
      }
      let listener = -1
      const childEnv = { ...env, ...command.env }
      if (ipc) {
        listener = k.listen(0)
        childEnv.NODE_CHANNEL_FD = String(k.sockPorts(listener).local)
        childEnv.NODE_CHANNEL_SERIALIZATION_MODE = 'json'
      } else delete childEnv.NODE_CHANNEL_FD
      let r
      try {
        r = k.spawn({ exec: command.exec, argv: command.argv, env: childEnv, cwd, stdio: specs })
      } catch (e: any) {
        if (listener >= 0) k.close(listener)
        loop.nextTick(() => this.emit('error', Object.assign(new Error(`spawn ${file} ${e.code}`), { code: e.code, errno: -e.errno, syscall: `spawn ${file}`, path: file, spawnargs: args })))
        return this
      }
      this.pid = r.pid
      this.#refed = true
      loop.ref()
      const { Readable, Writable } = rt.require('stream')
      if (r.stdio[0] >= 0) {
        const fd = r.stdio[0]
        k.setNonblock(fd, true)
        let closed = false
        const closeFd = () => {
          if (!closed) {
            closed = true
            loop.offFd(fd)
            try {
              k.close(fd)
            } catch {
              // already closed
            }
          }
        }
        this.stdin = new Writable({
          write(chunk: any, encoding: string, cb: (e?: Error | null) => void) {
            const bytes: Uint8Array = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk
            let off = 0
            const pump = () => {
              while (off < bytes.length) {
                const n = k.writeRaw(fd, off ? bytes.subarray(off) : bytes)
                if (n === -11) {
                  loop.onFd(fd, POLLOUT | 8 | POLLHUP, () => {
                    loop.offFd(fd)
                    pump()
                  })
                  return
                }
                if (n < 0) return cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' }))
                off += n
              }
              cb()
            }
            pump()
          },
          final(cb: () => void) {
            closeFd()
            cb()
          },
          destroy(err: Error | null, cb: (e?: Error | null) => void) {
            closeFd()
            cb(err)
          },
        })
        this.stdin.on('error', () => {})
      }
      const reader = (fd: number) => {
        k.setNonblock(fd, true)
        const buf = new Uint8Array(65536)
        let reading = false
        let ended = false
        this.#open++
        const end = () => {
          if (ended) return
          ended = true
          loop.offFd(fd)
          try {
            k.close(fd)
          } catch {
            // already closed
          }
          this.#open--
          this.#maybeClose()
        }
        const s = new Readable({
          highWaterMark: 65536,
          read() {
            if (reading || ended) return
            reading = true
            loop.onFd(fd, POLLIN | POLLHUP, () => {
              for (;;) {
                const n = k.readRaw(fd, buf)
                if (n === -11) return
                if (n <= 0) {
                  end()
                  s.push(null)
                  return
                }
                if (!s.push(Buffer.from(buf.slice(0, n)))) {
                  reading = false
                  loop.offFd(fd)
                  return
                }
              }
            })
          },
          destroy(err: Error | null, cb: (e?: Error | null) => void) {
            end()
            cb(err)
          },
        })
        return s
      }
      if (r.stdio[1] >= 0) this.stdout = reader(r.stdio[1])
      if (r.stdio[2] >= 0) this.stderr = reader(r.stdio[2])
      this.stdio = [this.stdin, this.stdout, this.stderr]
      // Output nobody listens to must still drain, or the child blocks on a full pipe and never exits.
      loop.nextTick(() => {
        for (const s of [this.stdout, this.stderr]) if (s && s.listenerCount('data') === 0 && s.listenerCount('readable') === 0 && !s.readableFlowing && s._readableState.pipes.length === 0) s._bat_idle = true
      })

      let channel: { ref(): void; unref(): void; close(): void } | undefined
      if (listener >= 0) {
        k.setNonblock(listener, true)
        this.#open++
        // Until the child has connected, messages wait here.
        const queued: unknown[][] = []
        this.connected = true
        ;(this as any).send = (...args: unknown[]) => {
          queued.push(args)
          return true
        }
        ;(this as any).disconnect = () => {
          this.connected = false
        }
        loop.onFd(listener, POLLIN, () => {
          const fd = k.accept(listener)
          if (fd === undefined) return
          loop.offFd(listener)
          k.close(listener)
          listener = -1
          const wasConnected = this.connected
          channel = attachIpc(this, fd, () => {
            this.#open--
            this.#maybeClose()
          })
          for (const args of queued) (this as any).send(...args)
          if (!wasConnected) (this as any).disconnect()
        })
      }
      loop.onChild(r.pid, (status: number) => {
        try {
          k.waitpid(r.pid, true)
        } catch {
          // reaped elsewhere
        }
        if (listener >= 0) {
          loop.offFd(listener)
          k.close(listener)
          this.#open--
        }
        this.#exited = true
        if (status > 128 && (this.killed || SIGNAL_NAMES[status - 128] === 'SIGKILL')) this.signalCode = SIGNAL_NAMES[status - 128] ?? null
        else this.exitCode = status
        if (this.#refed) {
          this.#refed = false
          loop.unref()
        }
        this.stdin?.destroy()
        this.emit('exit', this.exitCode, this.signalCode)
        // A stream nobody consumes would hold 'close' back forever.
        for (const s of [this.stdout, this.stderr]) if (s && s._bat_idle && !s.readableFlowing && s.listenerCount('data') === 0 && s.listenerCount('readable') === 0) s.resume()
        this.#maybeClose()
      })
      loop.nextTick(() => this.emit('spawn'))
      if (options?.signal) {
        const onAbort = () => {
          this.kill(options.killSignal ?? 'SIGTERM')
          this.emit('error', Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR', cause: options.signal.reason }))
        }
        if (options.signal.aborted) loop.nextTick(onAbort)
        else options.signal.addEventListener('abort', onAbort, { once: true })
      }
      if (options?.timeout > 0) {
        const t = loop.setTimeout(() => this.kill(options.killSignal ?? 'SIGTERM'), options.timeout)
        t.unref()
        this.once('exit', () => (rt.loop as any).clearTimeout(t))
      }
      void channel
      return this
    }
    #maybeClose() {
      if (this.#exited && this.#open <= 0) {
        this.#open = 1 << 30 // once
        loop.nextTick(() => this.emit('close', this.exitCode, this.signalCode))
      }
    }
    kill(sig: string | number = 'SIGTERM') {
      const n = typeof sig === 'number' ? sig : SIGNALS[sig]
      if (n === undefined) throw Object.assign(new TypeError(`Unknown signal: ${sig}`), { code: 'ERR_UNKNOWN_SIGNAL' })
      if (this.pid === undefined || this.#exited) return false
      try {
        k.kill(this.pid, n)
      } catch {
        return false
      }
      if (n !== 0) this.killed = true
      return true
    }
    ref() {
      if (!this.#refed && !this.#exited && this.pid !== undefined) {
        this.#refed = true
        loop.ref()
      }
    }
    unref() {
      if (this.#refed) {
        this.#refed = false
        loop.unref()
      }
    }
    [Symbol.dispose]() {
      this.kill()
    }
  }

  function normalizeSpawn(file: any, args?: any, options?: any): [string, string[], any] {
    if (typeof file !== 'string' || !file) throw Object.assign(new TypeError(`The "file" argument must be of type string. Received ${typeof file}`), { code: 'ERR_INVALID_ARG_TYPE' })
    if (!Array.isArray(args)) {
      options = args
      args = []
    }
    options = options ?? {}
    if (options.shell) {
      const line = [file, ...args].join(' ')
      return ['/bin/sh', ['-c', line], { ...options, shell: false }]
    }
    return [file, args.map(String), options]
  }

  function spawn(file: any, args?: any, options?: any) {
    const [f, a, o] = normalizeSpawn(file, args, options)
    return new ChildProcess()._spawn(f, a, o)
  }

  function spawnSync(file: any, args?: any, options?: any): any {
    const [f, a, o] = normalizeSpawn(file, args, options)
    const env = envOf(o)
    const cwd = cwdOf(o)
    const result: any = { pid: 0, output: [null, null, null], stdout: null, stderr: null, status: null, signal: null }
    const encode = (bytes: Uint8Array) => (o.encoding && o.encoding !== 'buffer' ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(o.encoding) : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    const command = resolveCommand(f, a, env, cwd)
    if (!command || k.kindOf(cwd) !== 1) {
      result.error = enoent(f, a, 'spawnSync')
      result.stdout = encode(new Uint8Array(0))
      result.stderr = encode(new Uint8Array(0))
      result.output = [null, result.stdout, result.stderr]
      return result
    }
    const { specs } = normalizeStdio(o.stdio)
    const childEnv = { ...env, ...command.env }
    delete childEnv.NODE_CHANNEL_FD
    const input = o.input !== undefined && o.input !== null ? (typeof o.input === 'string' ? Buffer.from(o.input, o.encoding && o.encoding !== 'buffer' ? o.encoding : 'utf8') : new Uint8Array(o.input.buffer ?? o.input, o.input.byteOffset ?? 0, o.input.byteLength)) : undefined
    let r
    try {
      r = k.spawn({ exec: command.exec, argv: command.argv, env: childEnv, cwd, stdio: specs })
    } catch (e: any) {
      result.error = Object.assign(new Error(`spawnSync ${f} ${e.code}`), { code: e.code, errno: -e.errno, syscall: `spawnSync ${f}`, path: f, spawnargs: a })
      return result
    }
    result.pid = r.pid
    const deadline = o.timeout > 0 ? performance.now() + o.timeout : Infinity
    const maxBuffer = o.maxBuffer ?? 1024 * 1024 * 1024
    const chunks: Uint8Array[][] = [[], [], []]
    const open = new Set<number>()
    for (const i of [1, 2]) if (r.stdio[i] >= 0) open.add(i)
    let stdin = r.stdio[0]
    let inOff = 0
    if (stdin >= 0) {
      if (!input || input.length === 0) {
        k.close(stdin)
        stdin = -1
      } else k.setNonblock(stdin, true)
    }
    const buf = new Uint8Array(65536)
    let total = 0
    let timedOut = false
    while (open.size || stdin >= 0) {
      const fds: { fd: number; events: number }[] = []
      const which: number[] = []
      for (const i of open) {
        fds.push({ fd: r.stdio[i], events: POLLIN | POLLHUP })
        which.push(i)
      }
      if (stdin >= 0) {
        fds.push({ fd: stdin, events: POLLOUT | 8 | POLLHUP })
        which.push(0)
      }
      const left = deadline - performance.now()
      if (left <= 0) {
        timedOut = true
        break
      }
      const revents = k.poll(fds, deadline === Infinity ? -1 : Math.ceil(left))
      for (let j = 0; j < fds.length; j++) {
        if (!revents[j]) continue
        const i = which[j]
        if (i === 0) {
          const n = k.writeRaw(stdin, input!.subarray(inOff))
          if (n >= 0) inOff += n
          if (n < 0 ? n !== -11 : inOff >= input!.length) {
            k.close(stdin)
            stdin = -1
          }
        } else {
          const n = k.read(fds[j].fd, buf)
          if (n === 0) {
            k.close(fds[j].fd)
            open.delete(i)
          } else {
            chunks[i].push(buf.slice(0, n))
            total += n
            if (total > maxBuffer) {
              result.error = Object.assign(new Error(`spawnSync ${f} ENOBUFS`), { code: 'ENOBUFS', errno: -105, syscall: `spawnSync ${f}` })
              open.clear()
              timedOut = true
              break
            }
          }
        }
      }
    }
    if (timedOut) {
      try {
        k.kill(r.pid, SIGNALS[o.killSignal as string] ?? 15)
      } catch {
        // already gone
      }
      for (const i of open) k.close(r.stdio[i])
      if (stdin >= 0) k.close(stdin)
      result.error ??= Object.assign(new Error(`spawnSync ${f} ETIMEDOUT`), { code: 'ETIMEDOUT', errno: -110, syscall: `spawnSync ${f}`, path: f, spawnargs: a })
    }
    let status: number | undefined
    if (deadline === Infinity || !timedOut) status = k.waitpid(r.pid)
    else {
      // A child that ignores the signal must not hang the parent forever.
      const until = performance.now() + 2000
      while ((status = k.waitpid(r.pid, true)) === undefined && performance.now() < until) k.poll([], 5)
      if (status === undefined) {
        try {
          k.kill(r.pid, 9)
        } catch {
          // already gone
        }
        status = k.waitpid(r.pid)
      }
    }
    const join = (list: Uint8Array[]) => {
      const out = new Uint8Array(list.reduce((n, c) => n + c.length, 0))
      let off = 0
      for (const c of list) {
        out.set(c, off)
        off += c.length
      }
      return out
    }
    if (r.stdio[1] >= 0) result.stdout = encode(join(chunks[1]))
    if (r.stdio[2] >= 0) result.stderr = encode(join(chunks[2]))
    result.output = [null, result.stdout, result.stderr]
    if (status !== undefined && status > 128 && timedOut) result.signal = SIGNAL_NAMES[status - 128] ?? null
    else result.status = status ?? null
    return result
  }

  function execFile(file: any, ...rest: any[]) {
    const cb: ((e: Error | null, stdout: any, stderr: any) => void) | undefined = typeof rest[rest.length - 1] === 'function' ? rest.pop() : undefined
    const args: string[] = Array.isArray(rest[0]) ? rest.shift() : []
    const options = rest[0] ?? {}
    const encoding = options.encoding === undefined ? 'utf8' : options.encoding
    const child = spawn(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Uint8Array[] = []
    const err: Uint8Array[] = []
    let done = false
    let size = 0
    const maxBuffer = options.maxBuffer ?? 1024 * 1024
    const text = (list: Uint8Array[]) => (encoding && encoding !== 'buffer' ? Buffer.concat(list).toString(encoding) : Buffer.concat(list))
    const finish = (error: any) => {
      if (done) return
      done = true
      if (error) {
        error.stdout = text(out)
        error.stderr = text(err)
        error.cmd = [file, ...args].join(' ')
      }
      cb?.(error, text(out), text(err))
    }
    const collect = (list: Uint8Array[]) => (chunk: Uint8Array) => {
      list.push(chunk)
      size += chunk.length
      if (size > maxBuffer) {
        child.kill()
        finish(Object.assign(new RangeError('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }))
      }
    }
    child.stdout?.on('data', collect(out))
    child.stderr?.on('data', collect(err))
    child.on('error', finish)
    child.on('close', (code: number | null, signal: string | null) => {
      if (code === 0 && signal === null) return finish(null)
      const e: any = new Error(`Command failed: ${[file, ...args].join(' ')}\n${text(err)}`)
      e.code = code
      e.killed = child.killed
      e.signal = signal
      finish(e)
    })
    if (options.input !== undefined) child.stdin?.end(options.input)
    else child.stdin?.end()
    return child
  }
  function exec(command: string, ...rest: any[]) {
    const cb = typeof rest[rest.length - 1] === 'function' ? rest.pop() : undefined
    return execFile('/bin/sh', ['-c', command], { ...rest[0], shell: false }, cb)
  }
  const promisifyCustom = Symbol.for('nodejs.util.promisify.custom')
  for (const fn of [exec, execFile] as any[]) {
    fn[promisifyCustom] = (...args: any[]) => {
      let child: any
      const promise: any = new Promise((resolve, reject) => {
        child = fn(...args, (e: Error | null, stdout: any, stderr: any) => (e ? reject(e) : resolve({ stdout, stderr })))
      })
      promise.child = child
      return promise
    }
  }
  function checkSync(r: any, file: string, args: string[], options: any) {
    if (r.error) throw r.error
    if (r.status !== 0) {
      const stderr = r.stderr ? String(r.stderr) : ''
      const e: any = new Error(`Command failed: ${[file, ...args].join(' ')}${stderr ? `\n${stderr}` : ''}`)
      Object.assign(e, r)
      throw e
    }
    // With stderr piped (the default), Node passes the child's stderr through to the parent's.
    if (r.stderr?.length && (options?.stdio === undefined || options.stdio === 'pipe')) rt.ctl!.writeFd(2, String(r.stderr))
    return r.stdout
  }
  function execFileSync(file: string, args?: any, options?: any) {
    if (!Array.isArray(args)) {
      options = args
      args = []
    }
    return checkSync(spawnSync(file, args, options), file, args, options)
  }
  function execSync(command: string, options?: any) {
    return checkSync(spawnSync('/bin/sh', ['-c', command], { ...options, shell: false }), command, [], options)
  }
  function fork(modulePath: any, args?: any, options?: any) {
    if (!Array.isArray(args)) {
      options = args
      args = []
    }
    options = options ?? {}
    const stdio = options.stdio ?? (options.silent ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['inherit', 'inherit', 'inherit', 'ipc'])
    const file = modulePath instanceof URL ? decodeURIComponent(modulePath.pathname) : String(modulePath)
    return spawn(options.execPath ?? proc.execPath, [...(options.execArgv ?? proc.execArgv), file, ...args], { ...options, stdio: Array.isArray(stdio) && !stdio.includes('ipc') ? [...stdio, 'ipc'] : stdio })
  }

  // The child side of fork: connect back to the parent's channel.
  if (proc.env.NODE_CHANNEL_FD && !proc.connected) {
    const port = Number(proc.env.NODE_CHANNEL_FD)
    delete proc.env.NODE_CHANNEL_FD
    try {
      const fd = k.connect(port)
      const channel = attachIpc(proc, fd, () => {})
      proc.channel = { ref: channel.ref, unref: channel.unref }
      // The channel keeps the child alive only while something listens for messages.
      const sync = () => (proc.listenerCount('message') > 0 || proc.listenerCount('disconnect') > 0 ? channel.ref() : channel.unref())
      proc.on('newListener', () => loop.nextTick(sync))
      proc.on('removeListener', () => loop.nextTick(sync))
    } catch {
      // the parent is gone
    }
  }

  return { ChildProcess, spawn, spawnSync, exec, execSync, execFile, execFileSync, fork, _forkChild() {} }
}

registerBuiltin('child_process', create)
