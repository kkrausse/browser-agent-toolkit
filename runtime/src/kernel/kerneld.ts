// kerneld: the supervisor worker. It never services filesystem calls. It
//  - creates process workers for spawn requests and keeps one warm spare,
//  - terminates them on SIGKILL / exit (through the kernel's kill gate),
//  - mounts images (it holds a handle on each, and faults chunks in for
//    threads that have none, i.e. the page),
//  - restores the overlay from OPFS at boot and drains the journal to it.
import { attachKernel, type KernelInstance } from './attach'
import { createKernel, type Kernel } from './kernel'
import { fnv1a32, imageExists, openImageHandle, opfsDir, removeImage, storeImage, type SyncHandle } from './opfs'

interface InitArgs {
  module: WebAssembly.Module
  memory: WebAssembly.Memory
  namespace: string
  persist: boolean
  noPersist: string[]
  processWorkerUrl: string
  processWorkerType?: 'module' | 'classic'
  runnerUrl: string
  warmSpare: boolean
}
interface Proc {
  worker: Worker
  thread: number
  pid: number
}

const JOURNAL_MAGIC = 0x4a544142 // "BATJ"
const FRAME_HEADER = 24
const SNAP_HEADER = 32
const SNAP_MAGIC = [0x42, 0x41, 0x54, 0x53, 0x4e, 0x41, 0x50, 0x31] // "BATSNAP1"
const SNAPSHOT_AT = 16 << 20

let inst: KernelInstance
let k: Kernel
let cfg: InitArgs
const handles: (SyncHandle | undefined)[] = []
const procs = new Map<number, Proc>()
let spare: Promise<Proc> | undefined
let journal: SyncHandle | undefined
let journalSize = 0
let nextSlot: 'snap-a' | 'snap-b' = 'snap-a'
let outP = 0
const stats = { spawns: 0, kills: 0, faults: 0, journalFrames: 0, journalBytes: 0, snapshots: 0 }

// ---- process workers ----

function createProcessWorker(): Promise<Proc> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(cfg.processWorkerUrl, { type: cfg.processWorkerType ?? 'module', name: 'bat-process' })
    const proc: Proc = { worker, thread: 0, pid: 0 }
    worker.onmessage = (e) => {
      const m = e.data
      if (m.type === 'ready') {
        proc.thread = m.thread
        resolve(proc)
      } else if (m.type === 'exited') {
        retire(proc, 0)
      } else if (m.type === 'error') {
        console.error('process worker:', m.error)
        if (proc.pid) k.x.bat_proc_mark_exited(proc.pid, 1)
        else reject(new Error(m.error))
      }
    }
    worker.onerror = (e) => {
      console.error('process worker crashed:', e.message)
      if (proc.pid) {
        k.x.bat_proc_mark_exited(proc.pid, 1)
        retire(proc, 0)
      } else reject(new Error(e.message))
    }
    worker.postMessage({ type: 'attach', module: cfg.module, memory: cfg.memory, namespace: cfg.namespace })
  })
}
function ensureSpare() {
  if (cfg.warmSpare && !spare) spare = createProcessWorker()
}
async function spawn(pid: number) {
  stats.spawns++
  const taken = spare ?? createProcessWorker()
  spare = undefined
  let proc: Proc
  try {
    proc = await taken
  } catch (e) {
    console.error('spawn failed:', e)
    k.x.bat_proc_mark_exited(pid, 127)
    return
  }
  proc.pid = pid
  procs.set(pid, proc)
  proc.worker.postMessage({ type: 'run', pid, runnerUrl: cfg.runnerUrl })
  ensureSpare()
}
/**
 * Stop a worker without leaving a kernel lock held: mark its thread dying
 * (it parks at its next lock acquisition), wait until it holds none, then
 * terminate. The stack is freed later, once the worker is certainly gone.
 */
function retire(proc: Proc, graceMs: number) {
  if (procs.get(proc.pid) === proc) procs.delete(proc.pid)
  const x = k.x
  const finish = () => {
    if (proc.thread) {
      x.bat_thread_mark_dying(proc.thread)
      const until = performance.now() + 2000
      while (x.bat_thread_lock_depth(proc.thread) !== 0 && performance.now() < until) {
        // spin: critical sections are short
      }
    }
    proc.worker.terminate()
    if (proc.thread) setTimeout(() => x.bat_thread_free(proc.thread), 5000)
  }
  if (graceMs > 0) setTimeout(finish, graceMs)
  else finish()
}
function kill(pid: number, sig: number) {
  stats.kills++
  const proc = procs.get(pid)
  if (proc) retire(proc, 0)
  k.x.bat_proc_mark_exited(pid, 128 + sig)
}

// ---- images ----

async function mount(name: string, path: string) {
  const t0 = performance.now()
  const id: number = k.x.bat_image_reserve()
  handles[id] = await openImageHandle(cfg.namespace, name)
  const tOpen = performance.now()
  const u8 = inst.u8()
  const enc = new TextEncoder()
  const nb = enc.encode(name)
  const pb = enc.encode(path)
  const p = k.x.bat_alloc(nb.length + pb.length + 8) >>> 0
  inst.u8().set(nb, p)
  inst.u8().set(pb, p + nb.length)
  void u8
  const rc = k.x.bat_image_mount(id, p, nb.length, p + nb.length, pb.length)
  k.x.bat_free(p, nb.length + pb.length + 8)
  if (rc < 0) throw new Error(`mount ${name} at ${path} failed: errno ${-rc}`)
  const t1 = performance.now()
  if (spare) void spare.then((s) => s.worker.postMessage({ type: 'images' })).catch(() => {})
  for (const proc of procs.values()) proc.worker.postMessage({ type: 'images' })
  return { id, entries: rc, ms: t1 - t0, openHandleMs: tOpen - t0, indexMs: t1 - tOpen }
}

// ---- overlay persistence ----

function readInto(h: SyncHandle, ptr: number, len: number, at: number) {
  let done = 0
  while (done < len) {
    const n = h.read(inst.u8().subarray(ptr + done, ptr + len), { at: at + done })
    if (n <= 0) throw new Error('short read from OPFS')
    done += n
  }
}
function writeFrom(h: SyncHandle, ptr: number, len: number, at: number) {
  let done = 0
  while (done < len) done += h.write(inst.u8().subarray(ptr + done, ptr + len), { at: at + done })
}
function replay(ptr: number, len: number): number {
  return k.x.bat_persist_replay(ptr, len)
}

async function restore() {
  const t0 = performance.now()
  const dir = await opfsDir(cfg.namespace, 'overlay')
  const open = async (name: string) =>
    (await ((await dir.getFileHandle(name, { create: true })) as any).createSyncAccessHandle()) as SyncHandle
  // Newest complete snapshot.
  let snapSeq = 0
  let best: { name: 'snap-a' | 'snap-b'; len: number } | undefined
  for (const name of ['snap-a', 'snap-b'] as const) {
    const h = await open(name)
    try {
      const size = h.getSize()
      if (size < SNAP_HEADER) continue
      const hdr = new Uint8Array(SNAP_HEADER)
      h.read(hdr, { at: 0 })
      const dv = new DataView(hdr.buffer)
      const ok = SNAP_MAGIC.every((b, i) => hdr[i] === b) && dv.getUint32(24, true) === 1
      const seq = dv.getFloat64(8, true)
      const len = dv.getFloat64(16, true)
      if (ok && size === SNAP_HEADER + len && (!best || seq > snapSeq)) {
        best = { name, len }
        snapSeq = seq
      }
    } finally {
      h.close()
    }
  }
  if (best) {
    const h = await open(best.name)
    const p = k.x.bat_alloc(best.len || 1) >>> 0
    try {
      readInto(h, p, best.len, SNAP_HEADER)
      replay(p, best.len)
    } finally {
      k.x.bat_free(p, best.len || 1)
      h.close()
    }
    nextSlot = best.name === 'snap-a' ? 'snap-b' : 'snap-a'
  }
  // Journal frames newer than the snapshot.
  journal = await open('journal')
  const size = journal.getSize()
  let seq = snapSeq
  let off = 0
  let frames = 0
  if (size > 0) {
    const file = new Uint8Array(size)
    journal.read(file, { at: 0 })
    const dv = new DataView(file.buffer)
    while (off + FRAME_HEADER <= size) {
      if (dv.getUint32(off, true) !== JOURNAL_MAGIC) break
      const len = dv.getUint32(off + 4, true)
      const sum = dv.getUint32(off + 8, true)
      const end = dv.getFloat64(off + 16, true)
      if (off + FRAME_HEADER + len > size) break
      const payload = file.subarray(off + FRAME_HEADER, off + FRAME_HEADER + len)
      if (fnv1a32(payload) !== sum) break
      if (end > snapSeq) {
        const p = k.x.bat_alloc(len || 1) >>> 0
        inst.u8().set(payload, p)
        replay(p, len)
        k.x.bat_free(p, len || 1)
        seq = end
        frames++
      }
      off += FRAME_HEADER + len
    }
    if (off < size) {
      // Torn tail from a crash mid-write.
      journal.truncate(off)
      journal.flush()
    }
  }
  journalSize = off
  // Enable first: the directories leading to a non-persistent root are
  // ordinary journaled directories (later records name them as parents).
  k.x.bat_persist_enable(seq)
  for (const path of cfg.noPersist) excludePath(path)
  return { snapshotSeq: snapSeq, seq, journalFrames: frames, journalBytes: off, ms: performance.now() - t0 }
}
function excludePath(path: string) {
  const b = new TextEncoder().encode(path)
  const p = k.x.bat_alloc(b.length + 1) >>> 0
  inst.u8().set(b, p)
  k.x.bat_persist_exclude(p, b.length)
  k.x.bat_free(p, b.length + 1)
}

function drainJournal() {
  if (!journal) return
  const x = k.x
  x.bat_journal_take(outP)
  const dv = inst.dv()
  const ptr = dv.getUint32(outP, true)
  const len = dv.getUint32(outP + 4, true)
  const seq = dv.getFloat64(outP + 8, true)
  if (len > 0) {
    const hdr = new Uint8Array(FRAME_HEADER)
    const h = new DataView(hdr.buffer)
    h.setUint32(0, JOURNAL_MAGIC, true)
    h.setUint32(4, len, true)
    h.setUint32(8, fnv1a32(inst.u8().subarray(ptr, ptr + len)), true)
    h.setFloat64(16, seq, true)
    journal.write(hdr, { at: journalSize })
    writeFrom(journal, ptr, len, journalSize + FRAME_HEADER)
    journal.flush()
    journalSize += FRAME_HEADER + len
    x.bat_blob_free(ptr, len)
    stats.journalFrames++
    stats.journalBytes += len
  }
  x.bat_persist_set_durable(seq)
  if (journalSize > SNAPSHOT_AT) void snapshot()
}

let snapshotting: Promise<unknown> | undefined
function snapshot() {
  return (snapshotting ??= (async () => {
    if (!journal) return { seq: 0, bytes: 0, ms: 0 }
    const t0 = performance.now()
    const dir = await opfsDir(cfg.namespace, 'overlay')
    const fh = await dir.getFileHandle(nextSlot, { create: true })
    const h = (await (fh as any).createSyncAccessHandle()) as SyncHandle
    // From here to the end there is no await: journal frames cannot interleave.
    const x = k.x
    let len = 0
    let seq = 0
    try {
      x.bat_persist_snapshot(outP)
      const dv = inst.dv()
      const ptr = dv.getUint32(outP, true)
      len = dv.getUint32(outP + 4, true)
      seq = dv.getFloat64(outP + 8, true)
      h.truncate(0)
      writeFrom(h, ptr, len, SNAP_HEADER)
      h.flush()
      const hdr = new Uint8Array(SNAP_HEADER)
      hdr.set(SNAP_MAGIC, 0)
      const hd = new DataView(hdr.buffer)
      hd.setFloat64(8, seq, true)
      hd.setFloat64(16, len, true)
      hd.setUint32(24, 1, true)
      h.write(hdr, { at: 0 })
      h.flush()
      x.bat_blob_free(ptr, len)
    } finally {
      h.close()
    }
    // Every journal frame on disk is now covered by the snapshot.
    journal.truncate(0)
    journal.flush()
    journalSize = 0
    nextSlot = nextSlot === 'snap-a' ? 'snap-b' : 'snap-a'
    x.bat_persist_set_durable(seq)
    stats.snapshots++
    return { seq, bytes: len, ms: performance.now() - t0 }
  })().finally(() => {
    snapshotting = undefined
  }))
}

// ---- the supervisor loop ----

async function supervise() {
  const x = k.x
  const word = x.BAT_KERNELD_WORD.value >>> 2
  for (;;) {
    const i32 = inst.i32()
    const seen = Atomics.load(i32, word)
    for (;;) {
      const kind = x.bat_kerneld_next(outP)
      if (kind === 0) break
      const dv = inst.dv()
      const a = dv.getUint32(outP, true)
      const b = dv.getUint32(outP + 4, true)
      try {
        if (kind === 1) void spawn(a)
        else if (kind === 2) kill(a, b)
        else if (kind === 3) {
          // The process called exit; give its worker a moment to post, then stop it.
          const proc = procs.get(a)
          if (proc) retire(proc, 50)
        } else if (kind === 4) {
          stats.faults++
          x.bat_image_fault(a, b)
        } else if (kind === 5) drainJournal()
      } catch (e) {
        console.error('kerneld:', e)
      }
    }
    const r = (Atomics as any).waitAsync(i32, word, seen, 250)
    if (r.async) await r.value
    if (journal && x.bat_persist_pending() > 0) {
      try {
        drainJournal()
      } catch (e) {
        console.error('kerneld journal:', e)
      }
    }
  }
}

async function init(args: InitArgs) {
  cfg = args
  if (args.persist) {
    // One writer per origin and namespace.
    const tryLock = () =>
      new Promise<boolean>((resolve) => {
        void navigator.locks.request(`bat-kernel:${args.namespace}`, { ifAvailable: true }, (lock) => {
          resolve(!!lock)
          return lock ? new Promise(() => {}) : undefined
        })
      })
    // A reload can find the previous document's kerneld still shutting down:
    // give the lock a moment before concluding another tab owns it.
    let got = await tryLock()
    for (let i = 0; !got && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100))
      got = await tryLock()
    }
    if (!got) {
      const e = new Error('This workspace is already open in another tab.') as Error & { code: string }
      e.code = 'EBUSY'
      throw e
    }
  }
  inst = await attachKernel({
    module: args.module,
    memory: args.memory,
    canBlock: true,
    host: {
      imageRead(image, offset, dst) {
        const h = handles[image]
        return h ? h.read(dst, { at: offset }) : -11
      },
    },
  })
  k = createKernel(inst)
  const pid: number = k.x.bat_host_proc_new()
  outP = k.x.bat_alloc(64) >>> 0
  const restored = args.persist ? await restore() : undefined
  if (!args.persist) for (const path of args.noPersist) excludePath(path)
  void supervise()
  ensureSpare()
  return { pid, restored }
}

const ops: Record<string, (a: any) => unknown> = {
  init,
  mount: (a: { name: string; path: string }) => mount(a.name, a.path),
  hasImage: (a: { name: string }) => imageExists(cfg.namespace, a.name),
  storeImage: async (a: { name: string; url: string }) => {
    const have = await imageExists(cfg.namespace, a.name)
    if (have !== undefined && !a.url.includes('#force')) return { bytes: have, ms: 0, cached: true }
    return { ...(await storeImage(cfg.namespace, a.name, a.url)), cached: false }
  },
  removeImage: (a: { name: string }) => removeImage(cfg.namespace, a.name),
  snapshot: () => snapshot(),
  flush: () => drainJournal(),
  spareReady: async () => {
    ensureSpare()
    await spare
    return true
  },
  stats: () => ({ ...stats, journalSize, procs: [...procs.keys()] }),
}

self.onmessage = async (e: MessageEvent) => {
  const { id, op, args } = e.data
  try {
    const value = await ops[op](args)
    postMessage({ id, ok: true, value })
  } catch (err) {
    postMessage({ id, ok: false, error: String((err as Error)?.message ?? err), code: (err as any)?.code })
  }
}
