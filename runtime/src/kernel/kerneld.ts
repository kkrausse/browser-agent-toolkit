// kerneld: the supervisor worker. It never services filesystem calls. It
//  - creates process workers for spawn requests and keeps one warm spare,
//  - terminates them on SIGKILL / exit (through the kernel's kill gate),
//  - mounts images (it holds a handle on each, and faults chunks in for
//    threads that have none, i.e. the page),
//  - restores the overlay from OPFS at boot and drains the journal to it.
import { attachKernel, type KernelInstance } from './attach'
import { createKernel, type Kernel } from './kernel'
import { trace, traceEnable } from '../trace'
import { fnv1a32, imageExists, openImageHandle, opfsDir, preopenImage, removeImage, storeImage, type SyncHandle } from './opfs'
import { waitWord } from './wait'

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
  /** Warm process workers made at boot (default 1); afterwards one is kept. */
  spares?: number
  /** Program scripts each boot-time spare starts loading at once (names per spare); a spawn that
   * asks for exactly those (BAT_PROGRAMS) gets that worker. */
  spareHints?: string[][]
  /** Names of images that will be mounted: handles are opened ahead of the mount. */
  images?: string[]
  trace?: boolean
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
// A journal is replayed record by record at the next open; a snapshot is read in one piece.
// Once the overlay has been quiet for a while, a journal of this size is folded into a snapshot,
// so an open normally restores from a snapshot and a short journal.
const SNAPSHOT_IDLE_AT = 1 << 20
const SNAPSHOT_IDLE_MS = 5000

let inst: KernelInstance
let k: Kernel
let cfg: InitArgs
const handles: (SyncHandle | undefined)[] = []
const procs = new Map<number, Proc>()
/** Warm workers. `hint`: the program scripts it is loading ('' = none, usable by any spawn). */
const spares: { hint: string; ready: Promise<Proc> }[] = []
let journal: SyncHandle | undefined
let journalSize = 0
let journalWrittenAt = 0
let nextSlot: 'snap-a' | 'snap-b' = 'snap-a'
let outP = 0
const stats = { spawns: 0, kills: 0, faults: 0, snapshotReads: 0, journalFrames: 0, journalBytes: 0, snapshots: 0 }

// ---- process workers ----

function createProcessWorker(programs: string[] = []): Promise<Proc> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(cfg.processWorkerUrl, { type: cfg.processWorkerType ?? 'module', name: 'bat-process' })
    const proc: Proc = { worker, thread: 0, pid: 0 }
    worker.onmessage = (e) => {
      const m = e.data
      if (m.type === 'ready') {
        proc.thread = m.thread
        trace('worker.ready', { thread: m.thread })
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
    worker.postMessage({ type: 'attach', module: cfg.module, memory: cfg.memory, namespace: cfg.namespace, images: cfg.images, programs })
  })
}
function addSpare(programs: string[] = []) {
  const spare = { hint: programs.join(','), ready: createProcessWorker(programs) }
  // A worker that failed to start must not be handed to a spawn later.
  spare.ready.catch(() => {
    const i = spares.indexOf(spare)
    if (i >= 0) spares.splice(i, 1)
  })
  spares.push(spare)
}
/** Keep `count` warm workers that any spawn can use. */
function ensureSpare(count = 1) {
  if (!cfg.warmSpare) return
  for (let have = spares.filter((s) => s.hint === '').length; have < count; have++) addSpare()
}
/** The warm worker for a spawn: one already loading the programs it asks for, else an uncommitted one. */
function takeSpare(pid: number): Promise<Proc> | undefined {
  let want = ''
  try {
    want = k.procInfo(pid).env.BAT_PROGRAMS ?? ''
  } catch {
    // the process is already gone; any worker will find that out
  }
  let i = want ? spares.findIndex((s) => s.hint === want) : -1
  // A launch's own spare was taken: this is the start-up, and the cores belong to it. The
  // general-purpose spare is made a moment later instead of beside it.
  if (i >= 0) refillAt = performance.now() + 1500
  else i = spares.findIndex((s) => s.hint === '')
  return i < 0 ? undefined : spares.splice(i, 1)[0].ready
}
let refillAt = 0
function refillSpare() {
  const wait = refillAt - performance.now()
  if (wait > 0) setTimeout(refillSpare, wait)
  else ensureSpare()
}
async function spawn(pid: number) {
  stats.spawns++
  trace('spawn.request', { pid, spares: spares.length })
  const taken = takeSpare(pid) ?? createProcessWorker()
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
  trace('spawn.run', { pid })
  proc.worker.postMessage({ type: 'run', pid, runnerUrl: cfg.runnerUrl })
  refillSpare()
}
/**
 * Stop a worker without leaving a kernel lock held: mark its thread dying
 * (it parks at its next lock acquisition), wait until it holds none, then
 * terminate. The stack is freed later, once the worker is certainly gone.
 */
const retired = new WeakSet<Proc>()
function retire(proc: Proc, graceMs: number) {
  // Once only: a worker can be reported both by its own message and by the kernel, and a
  // second pass freed the thread record twice (the page then spun on a kernel lock).
  if (retired.has(proc)) return
  retired.add(proc)
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

// An image that is still being downloaded, where its writer's sync access handle is the only
// one the file can have (WebKit): until the download ends, this worker reads the growing file
// through snapshots. `getFile()` gives a File of what has been written so far (flushed or
// not), and `FileReaderSync` reads a slice of it; both work while the writer holds its handle
// (runtime/harness/webkit/probe-getfile.ts). Taking a snapshot is asynchronous and the
// kernel's read is not, so a fault is served in two steps: the bytes are read into `stash`,
// then the kernel is told to load the chunk and finds them there. A range that has not
// arrived comes back short, which the kernel answers as it does for any arriving image: the
// reader waits for `bat_image_progress` and asks again.
interface ArrivingImage {
  name: string
  file: FileSystemFileHandle
  stash: { at: number; bytes: Uint8Array }[]
  /** Chunks being fetched. */
  pending: Set<number>
}
const arrivingImages: (ArrivingImage | undefined)[] = []
const IMAGE_CHUNK = 1 << 17 // the kernel's (crates/bat-kernel/src/image.rs)
// One snapshot read costs about 1.5 ms whatever its length up to this, and a start-up reads
// the image front to back (prepare lays it out in that order): fetch what follows as well.
const SNAPSHOT_CHUNKS = 8
let snapshotReader: { readAsArrayBuffer(blob: Blob): ArrayBuffer } | undefined

/** Up to `length` bytes at `at` of what the file holds now; fewer when it ends before that. */
async function readSnapshot(file: FileSystemFileHandle, at: number, length: number): Promise<Uint8Array> {
  snapshotReader ??= new (globalThis as any).FileReaderSync()
  for (let attempt = 0; ; attempt++) {
    const snapshot = await file.getFile()
    if (snapshot.size <= at) return new Uint8Array(0)
    try {
      return new Uint8Array(snapshotReader!.readAsArrayBuffer(snapshot.slice(at, Math.min(snapshot.size, at + length))))
    } catch (e) {
      // A snapshot stops being readable when the file is written to after it was taken: take another.
      if (attempt >= 8) throw e
    }
  }
}
function readStash(image: ArrivingImage, offset: number, dst: Uint8Array): number {
  for (const s of image.stash) {
    if (offset >= s.at && offset + dst.length <= s.at + s.bytes.length) {
      dst.set(s.bytes.subarray(offset - s.at, offset - s.at + dst.length))
      return dst.length
    }
  }
  return 0 // not arrived (or not fetched): a short read
}
async function faultArriving(id: number, chunk: number) {
  const image = arrivingImages[id]
  if (!image || image.pending.has(chunk)) return
  image.pending.add(chunk)
  try {
    const at = chunk * IMAGE_CHUNK
    const bytes = await readSnapshot(image.file, at, SNAPSHOT_CHUNKS * IMAGE_CHUNK)
    if (arrivingImages[id] !== image) {
      // The download ended meanwhile and the file is open: an ordinary fault.
      if (handles[id]) k.x.bat_image_fault(id, chunk)
      return
    }
    if (!bytes.length) return
    const stashed = { at, bytes }
    image.stash.push(stashed)
    stats.snapshotReads++
    try {
      // The chunk asked for, and the whole chunks read along with it. (A chunk cut short by the
      // end of what has arrived stays unloaded; the image's last chunk is short by itself.)
      for (let ci = chunk; ci * IMAGE_CHUNK < at + bytes.length; ci++) k.x.bat_image_fault(id, ci)
    } finally {
      image.stash.splice(image.stash.indexOf(stashed), 1)
    }
  } catch (e) {
    console.error('kerneld: reading an arriving image:', e)
  } finally {
    image.pending.delete(chunk)
  }
}
/** The download is complete and its writer has closed the file: read it through a handle from here on. */
async function imageArrived(id: number) {
  const image = arrivingImages[id]
  if (!image) return
  handles[id] = await openImageHandle(cfg.namespace, image.name, true)
  arrivingImages[id] = undefined
}

async function mount(name: string, path: string, arriving = false, snapshot?: { headBytes: number }) {
  const t0 = performance.now()
  const id: number = k.x.bat_image_reserve()
  // Before the mount: from its first read on, a range that is not in the file yet is waited for.
  if (arriving) k.x.bat_image_arriving(id, 1)
  let head: ArrivingImage['stash'][number] | undefined
  if (arriving && snapshot) {
    const file = await (await opfsDir(cfg.namespace, 'images')).getFileHandle(name)
    // The mount reads the head, which is in the file before the image is announced.
    head = { at: 0, bytes: await readSnapshot(file, 0, snapshot.headBytes) }
    arrivingImages[id] = { name, file, stash: [head], pending: new Set() }
  } else {
    // kerneld is the keeper: where a file can have one handle only, this is it (opfs.ts).
    handles[id] = await openImageHandle(cfg.namespace, name, true)
  }
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
  // The kernel keeps the head in its own memory.
  const still = arrivingImages[id]
  if (head && still) still.stash.splice(still.stash.indexOf(head), 1)
  const t1 = performance.now()
  for (const spare of spares) void spare.ready.then((s) => s.worker.postMessage({ type: 'images' })).catch(() => {})
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
  journalWrittenAt = performance.now()
  // Enable first: the directories leading to a non-persistent root are
  // ordinary journaled directories (later records name them as parents).
  k.x.bat_persist_enable(seq)
  for (const path of cfg.noPersist) excludePath(path)
  return { snapshotSeq: snapSeq, seq, snapshotBytes: best?.len ?? 0, journalFrames: frames, journalBytes: off, ms: performance.now() - t0 }
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
    journalWrittenAt = performance.now()
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
          if (arrivingImages[a]) void faultArriving(a, b)
          else x.bat_image_fault(a, b)
        } else if (kind === 5) drainJournal()
      } catch (e) {
        console.error('kerneld:', e)
      }
    }
    await waitWord(i32, word, seen, 250)
    if (journal && x.bat_persist_pending() > 0) {
      try {
        drainJournal()
      } catch (e) {
        console.error('kerneld journal:', e)
      }
    } else if (journal && journalSize > SNAPSHOT_IDLE_AT && performance.now() - journalWrittenAt > SNAPSHOT_IDLE_MS) {
      void snapshot().catch((e) => console.error('kerneld snapshot:', e))
    }
  }
}

async function init(args: InitArgs) {
  cfg = args
  if (args.trace) traceEnable('kerneld')
  trace('kerneld.init')
  // Before the lock and the overlay restore, so the workers boot while those run: a process
  // worker only needs the shared memory, which the page has already initialised. (When the
  // lock is refused they die with this worker.)
  if (args.warmSpare) for (const programs of args.spareHints ?? []) addSpare(programs)
  ensureSpare((args.spares ?? 1) - (args.spareHints?.length ?? 0))
  for (const name of args.images ?? []) preopenImage(args.namespace, name, true)
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
    trace('kerneld.locked')
  }
  inst = await attachKernel({
    module: args.module,
    memory: args.memory,
    canBlock: true,
    host: {
      imageRead(image, offset, dst) {
        const h = handles[image]
        if (h) return h.read(dst, { at: offset })
        const arriving = arrivingImages[image]
        return arriving ? readStash(arriving, offset, dst) : -11
      },
    },
  })
  k = createKernel(inst)
  trace('kerneld.attached')
  const pid: number = k.x.bat_host_proc_new()
  outP = k.x.bat_alloc(64) >>> 0
  const restored = args.persist ? await restore() : undefined
  trace('kerneld.restored', restored)
  if (!args.persist) for (const path of args.noPersist) excludePath(path)
  void supervise()
  return { pid, restored }
}

const ops: Record<string, (a: any) => unknown> = {
  init,
  mount: (a: { name: string; path: string; arriving?: boolean; snapshot?: { headBytes: number } }) => mount(a.name, a.path, a.arriving, a.snapshot),
  imageArrived: (a: { id: number }) => imageArrived(a.id),
  hasImage: (a: { name: string }) => imageExists(cfg.namespace, a.name),
  storeImage: async (a: { name: string; url: string }) => {
    const have = await imageExists(cfg.namespace, a.name)
    if (have !== undefined && !a.url.includes('#force')) return { bytes: have, ms: 0, cached: true }
    return { ...(await storeImage(cfg.namespace, a.name, a.url)), cached: false }
  },
  removeImage: (a: { name: string }) => removeImage(cfg.namespace, a.name),
  snapshot: () => snapshot(),
  /** At close: leave a snapshot and an empty journal for the next open when the journal is worth folding. */
  compact: () => {
    drainJournal()
    return journal && journalSize > SNAPSHOT_IDLE_AT ? snapshot() : undefined
  },
  flush: () => drainJournal(),
  spareReady: async () => {
    ensureSpare()
    await Promise.all(spares.map((s) => s.ready))
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
