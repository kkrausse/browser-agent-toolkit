// Instantiate the kernel module over the shared memory and give this instance
// its own stack and TLS. Protocol: docs/design/kernel-abi.md "Attaching".

export interface KernelInstance {
  /** Raw C-ABI exports. */
  x: Record<string, any>
  memory: WebAssembly.Memory
  module: WebAssembly.Module
  /** Pointer to this instance's Thread record (pass to kerneld for reaping). */
  thread: number
  tid: number
  canBlock: boolean
  /** Current views; call after any kernel call that may have grown memory. */
  u8(): Uint8Array
  i32(): Int32Array
  dv(): DataView
  /** Host-side hooks the kernel calls; replaceable per worker. */
  host: KernelHost
  /** Let go of the memory: afterwards `x` throws and the views are empty. For the page,
   * whose objects outlive a closed runtime; the memory itself goes when no thread holds it. */
  release(): void
}

/** What `x` is after `release()`. */
export const closedExports: Record<string, any> = new Proxy({}, {
  get() {
    throw new Error('The runtime is closed')
  },
})

export interface KernelHost {
  /** Read `len` bytes at `offset` of image `image` into `dst`. Returns bytes read or -errno. */
  imageRead(image: number, offset: number, dst: Uint8Array): number
  /** The next bytes of the snapshot the kernel is writing (kerneld only). Returns 0 or -errno. */
  persistWrite(bytes: Uint8Array): number
  log(level: number, message: string): void
  /** The kernel is dead (see `deadKernel`); called once, by the first call that finds it so. */
  dead?(error: Error): void
}

/**
 * The error of every kernel call once the kernel is dead: a thread trapped while it held a
 * kernel lock (an allocation that failed, a bug), so the state under that lock can never be
 * reached again. `BAT_KERNEL_DEAD` in the shared memory says so to every thread.
 */
export function deadKernel(cause?: unknown): Error & { code: string } {
  const detail = cause instanceof Error ? ` (${cause.name}: ${cause.message})` : ''
  return Object.assign(new Error(`The runtime has failed: its kernel stopped while it held a lock${detail}. What was saved before is kept; reload the page.`, { cause }), { code: 'BAT_KERNEL_DEAD' })
}

export interface AttachOptions {
  module: WebAssembly.Module
  memory: WebAssembly.Memory
  /** True in workers (may `Atomics.wait`); false on the page and in service workers. */
  canBlock: boolean
  /** True only for the instance that created the memory: runs one-time kernel init. */
  first?: boolean
  stackSize?: number
  host?: Partial<KernelHost>
}

/** Size of the kernel memory in 64 KiB pages. */
export interface KernelMemoryOptions {
  /** Pages the memory is created with. Default 4,096 (256 MiB). Everything the kernel
   * holds lives in it: the files programs write, pipes, the image index and chunk cache. */
  pages?: number
  /** Declared maximum. Default: `pages`, a memory of fixed size that is never grown. Larger:
   * the kernel grows it when it is full (in WebKit a grow of a shared memory can crash the
   * tab, and its maximum is reserved as address space when it is made). At most 65,536. */
  maximumPages?: number
}

/** 256 MiB: docs/design/decisions.md, "the kernel memory has a fixed size". */
export const KERNEL_PAGES_DEFAULT = 4096

/** A memory does not tell its declared maximum, and the kernel has to know it. */
const declaredMaximum = new WeakMap<WebAssembly.Memory, number>()

export function createKernelMemory(options: KernelMemoryOptions = {}): WebAssembly.Memory {
  const whole = (value: number | undefined, fallback: number) => (Number.isFinite(value) ? Math.floor(value as number) : fallback)
  const initial = Math.min(65536, Math.max(64, whole(options.pages, KERNEL_PAGES_DEFAULT)))
  const maximum = Math.min(65536, Math.max(initial, whole(options.maximumPages, initial)))
  try {
    const memory = new WebAssembly.Memory({ initial, maximum, shared: true })
    declaredMaximum.set(memory, maximum)
    return memory
  } catch (cause) {
    const mib = (pages: number) => `${pages / 16} MiB`
    throw new Error(
      `kernel: this browser refused a shared memory of ${mib(initial)}${maximum > initial ? ` (maximum ${mib(maximum)})` : ''}: ${(cause as Error)?.message ?? cause}. A smaller one can be asked for with the boot option kernelMemory.pages.`,
      { cause },
    )
  }
}

const decoder = new TextDecoder()

export async function attachKernel(opts: AttachOptions): Promise<KernelInstance> {
  const { module, canBlock } = opts
  let memory = opts.memory
  let u8 = new Uint8Array(memory.buffer)
  let i32 = new Int32Array(memory.buffer)
  let dv = new DataView(memory.buffer)
  let memGenIdx = -1
  let memGen = -1
  const refresh = () => {
    u8 = new Uint8Array(memory.buffer)
    i32 = new Int32Array(memory.buffer)
    dv = new DataView(memory.buffer)
  }
  // Growth by any instance replaces `memory.buffer`. Old views stay valid for
  // the old range, so the generation word can be read through a stale view.
  const fresh = () => {
    if (memGenIdx >= 0) {
      const g = Atomics.load(i32, memGenIdx)
      if (g !== memGen) {
        memGen = g
        refresh()
      }
    }
  }
  const host: KernelHost = {
    imageRead: () => -11, // no handle on this thread: the kernel asks kerneld
    persistWrite: () => -5,
    log: (level, message) => (level >= 3 ? console.error(message) : console.log(message)),
    ...opts.host,
  }
  const text = (ptr: number, len: number) => {
    fresh()
    // TextDecoder refuses shared buffers; copy out.
    return decoder.decode(u8.slice(ptr, ptr + len))
  }
  const imports: WebAssembly.Imports = {
    env: { memory },
    bat: {
      host_wait(addr: number, expect: number, timeoutMs: number): number {
        fresh()
        const r = Atomics.wait(i32, addr >>> 2, expect | 0, timeoutMs < 0 ? Infinity : timeoutMs)
        return r === 'ok' ? 0 : r === 'not-equal' ? 1 : 2
      },
      host_notify(addr: number, count: number): number {
        fresh()
        return Atomics.notify(i32, addr >>> 2, count >>> 0 === 0xffffffff ? Infinity : count)
      },
      host_log(level: number, ptr: number, len: number) {
        host.log(level, text(ptr, len))
      },
      host_now_ms: () => performance.timeOrigin + performance.now(),
      host_image_read(image: number, offset: number, ptr: number, len: number): number {
        fresh()
        return host.imageRead(image, offset, u8.subarray(ptr, ptr + len))
      },
      host_persist_write(ptr: number, len: number): number {
        fresh()
        return host.persistWrite(u8.subarray(ptr, ptr + len))
      },
    },
    // std pulls these in; the kernel never uses WASI for real work.
    wasi_snapshot_preview1: {
      environ_get: () => 0,
      environ_sizes_get(countPtr: number, sizePtr: number) {
        fresh()
        dv.setUint32(countPtr, 0, true)
        dv.setUint32(sizePtr, 0, true)
        return 0
      },
      fd_write(_fd: number, iovs: number, iovsLen: number, nwritten: number) {
        fresh()
        let total = 0
        let s = ''
        for (let i = 0; i < iovsLen; i++) {
          const p = dv.getUint32(iovs + i * 8, true)
          const l = dv.getUint32(iovs + i * 8 + 4, true)
          s += decoder.decode(u8.slice(p, p + l))
          total += l
        }
        if (s) host.log(3, s.trimEnd())
        dv.setUint32(nwritten, total, true)
        return 0
      },
      proc_exit(code: number) {
        throw new Error(`kernel proc_exit(${code})`)
      },
      sched_yield: () => 0,
      clock_time_get(_id: number, _prec: bigint, out: number) {
        fresh()
        dv.setBigUint64(out, BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6)), true)
        return 0
      },
      random_get(ptr: number, len: number) {
        fresh()
        const tmp = new Uint8Array(len)
        crypto.getRandomValues(tmp)
        u8.set(tmp, ptr)
        return 0
      },
    },
    wasi: { 'thread-spawn': () => -1 },
  }
  // Async instantiation: Chrome forbids large synchronous instantiation on the page.
  const instance = await WebAssembly.instantiate(module, imports)
  const raw = instance.exports as Record<string, any>
  memGenIdx = raw.BAT_MEM_GEN.value >>> 2
  // A dead kernel is an error, not a wait. Every call first looks at the word that says so,
  // and a call that traps while this thread holds a kernel lock (its count is the first
  // word of its Thread record) sets it: no other thread will ever get that lock. Both words
  // are below the heap, so a view from before a grow still reads them.
  const deadIdx = raw.BAT_KERNEL_DEAD.value >>> 2
  let thread = 0
  let told = false
  const failed = (cause?: unknown): Error => {
    const error = deadKernel(cause)
    if (!told) {
      told = true
      host.dead?.(error)
    }
    return error
  }
  const trapped = (e: unknown): unknown => {
    if (!(e instanceof WebAssembly.RuntimeError)) return e
    if (thread && Atomics.load(i32, thread >>> 2) > 0) Atomics.store(i32, deadIdx, 1)
    return Atomics.load(i32, deadIdx) !== 0 ? failed(e) : e
  }
  const alive = () => {
    if (Atomics.load(i32, deadIdx) !== 0) throw failed()
  }
  // By arity: a syscall is a call, and these stay as cheap as the engine makes them.
  const guard = (f: (...a: any[]) => any): ((...a: any[]) => any) => {
    switch (f.length) {
      case 0: return () => { alive(); try { return f() } catch (e) { throw trapped(e) } }
      case 1: return (a) => { alive(); try { return f(a) } catch (e) { throw trapped(e) } }
      case 2: return (a, b) => { alive(); try { return f(a, b) } catch (e) { throw trapped(e) } }
      case 3: return (a, b, c) => { alive(); try { return f(a, b, c) } catch (e) { throw trapped(e) } }
      case 4: return (a, b, c, d) => { alive(); try { return f(a, b, c, d) } catch (e) { throw trapped(e) } }
      case 5: return (a, b, c, d, e5) => { alive(); try { return f(a, b, c, d, e5) } catch (e) { throw trapped(e) } }
      default: return (...a) => { alive(); try { return f(...a) } catch (e) { throw trapped(e) } }
    }
  }
  const x: Record<string, any> = {}
  for (const [name, value] of Object.entries(raw)) x[name] = typeof value === 'function' ? guard(value) : value

  if (opts.first) {
    // Before the first allocation: the heap's ceiling.
    x.bat_mem_configure(declaredMaximum.get(memory) ?? memory.buffer.byteLength / 65536)
    x._initialize?.()
  }
  // Until this instance has its own stack it runs on the module's boot stack,
  // which every fresh instance shares: hold the boot lock across that window.
  const lockIdx = x.BAT_BOOT_LOCK.value >>> 2
  while (Atomics.compareExchange(i32, lockIdx, 0, 1) !== 0) {
    if (canBlock) Atomics.wait(i32, lockIdx, 1, 5)
  }
  try {
    thread = x.bat_thread_alloc(opts.stackSize ?? 1 << 20, x.__tls_size.value, x.__tls_align.value) >>> 0
    if (!thread) throw new Error('kernel: out of memory attaching thread')
    fresh()
    x.__stack_pointer.value = dv.getUint32(thread + 28, true)
    x.__wasm_init_tls(dv.getUint32(thread + 32, true))
  } finally {
    Atomics.store(i32, lockIdx, 0)
    Atomics.notify(i32, lockIdx, 1)
  }
  const tid = x.bat_thread_start(thread, canBlock ? 1 : 0)
  if (opts.first) x.bat_kernel_init()

  const inst: KernelInstance = {
    x,
    memory,
    module,
    thread,
    tid,
    canBlock,
    host,
    u8: () => (fresh(), u8),
    i32: () => (fresh(), i32),
    dv: () => (fresh(), dv),
    release() {
      // Every reference this binding has to the memory, its buffer and the instance. (The
      // imports above keep `memory` only through this variable.)
      memGenIdx = -1
      const none = new ArrayBuffer(8)
      u8 = new Uint8Array(none)
      i32 = new Int32Array(none)
      dv = new DataView(none)
      memory = undefined as unknown as WebAssembly.Memory
      inst.x = closedExports
      inst.memory = undefined as unknown as WebAssembly.Memory
    },
  }
  return inst
}
