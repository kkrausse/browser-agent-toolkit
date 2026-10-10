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
}

export interface KernelHost {
  /** Read `len` bytes at `offset` of image `image` into `dst`. Returns bytes read or -errno. */
  imageRead(image: number, offset: number, dst: Uint8Array): number
  log(level: number, message: string): void
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

export const KERNEL_PAGES_INITIAL = 64

export function createKernelMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: KERNEL_PAGES_INITIAL, maximum: 65536, shared: true })
}

const decoder = new TextDecoder()

export async function attachKernel(opts: AttachOptions): Promise<KernelInstance> {
  const { memory, module, canBlock } = opts
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
  const x = instance.exports as Record<string, any>
  memGenIdx = x.BAT_MEM_GEN.value >>> 2

  if (opts.first) {
    x._initialize?.()
  }
  // Until this instance has its own stack it runs on the module's boot stack,
  // which every fresh instance shares: hold the boot lock across that window.
  const lockIdx = x.BAT_BOOT_LOCK.value >>> 2
  while (Atomics.compareExchange(i32, lockIdx, 0, 1) !== 0) {
    if (canBlock) Atomics.wait(i32, lockIdx, 1, 5)
  }
  let thread = 0
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

  return {
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
  }
}
