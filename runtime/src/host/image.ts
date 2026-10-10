// The dependency images in OPFS: fetch-or-reuse by content hash. Runs in a
// worker (the bridge worker) because it writes through a sync access handle;
// the page only sees progress messages.
//
// Transport: the server answers the image URL with `Content-Encoding: zstd`
// when prepare wrote a compressed copy, and the browser decodes it in its
// network stack (Chrome 154 has no zstd in `DecompressionStream`), so the
// stream read here is always the image's own bytes.
//
// Integrity: prepare writes the SHA-256 of every block of the image
// (`<image>.sums`, itself hashed in the manifest). A block is hashed with
// WebCrypto and compared BEFORE it is written, so nothing that was not
// verified is ever in the file, and the image can be used while it arrives:
// once the head is in the file the caller is told (`usable`), mounts it, and
// kernel reads of ranges that are not there yet wait for them.
//
// Names. `image-<hash>.batimg` exists only complete and verified, as before.
// A download goes to `<name>.partial`. That file cannot be renamed while
// workers hold it open (which they do when it was mounted early), so a
// finished download is marked by `<name>.partial.ok` and renamed by the next
// open, before anyone holds it.
import { opfsDir, type SyncHandle } from '../kernel/opfs'

export interface StoreImageArgs {
  namespace: string
  /** OPFS file name; content-addressed (`image-<hash>.batimg`). */
  name: string
  url: string
  /** Expected size and lower-case hex SHA-256 of the image. */
  bytes?: number
  sha256?: string
  /** Length of the image head: the file is usable (mountable) once this much is in it. */
  headBytes?: number
  /** With a start-up order: where the bodies a start-up reads end. The download stops
   * reading there until `resume` settles, so that what the programs fetch to start (their
   * program scripts, the runtime's Wasm) does not share the link with 200 MB nobody waits for. */
  firstBytes?: number
  /** Per-block SHA-256 file written by prepare, and its own hash. */
  sums?: { url: string; blockBytes: number; sha256: string }
  /** bat_node_native.wasm: streaming SHA-256 for a prepared directory without block sums. */
  nativeWasmUrl?: string
}

export interface StoreImageResult {
  bytes: number
  ms: number
  cached: boolean
  verified: boolean
  /** The OPFS file that holds the image now (`name`, or `name.partial` when it is held open). */
  file: string
}

export interface StoreImageProgress {
  loaded?: number
  total?: number
  /** Sent once: `file` can be opened and its head read. `arriving`: the rest is still being written. */
  usable?: { file: string; arriving: boolean }
}

interface Hasher {
  update(chunk: Uint8Array): void
  hex(): string
}

const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')

async function sha256Stream(url: string): Promise<Hasher> {
  const { instance } = await WebAssembly.instantiateStreaming(fetch(url), {})
  const x = instance.exports as any
  const CAP = 1 << 20
  const buf: number = x.bat_alloc(CAP)
  const h: number = x.bat_hash_new(3)
  return {
    update(chunk) {
      for (let at = 0; at < chunk.length; at += CAP) {
        const part = chunk.subarray(at, at + CAP)
        new Uint8Array(x.memory.buffer, buf, part.length).set(part)
        x.bat_hash_update(h, buf, part.length)
      }
    },
    hex() {
      const n: number = x.bat_hash_final(h, buf)
      // `bat_hash_final` consumes the hasher.
      return hex(new Uint8Array(x.memory.buffer, buf, n))
    },
  }
}

const partialOf = (name: string) => `${name}.partial`
const markOf = (name: string) => `${name}.partial.ok`

async function sizeOf(dir: FileSystemDirectoryHandle, name: string): Promise<number | undefined> {
  try {
    return (await (await dir.getFileHandle(name)).getFile()).size
  } catch {
    return undefined
  }
}

/** The block sums, verified against the manifest. */
async function fetchSums(sums: NonNullable<StoreImageArgs['sums']>, blocks: number, signal?: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(sums.url, { signal })
  if (!res.ok) throw new Error(`image sums download failed: HTTP ${res.status} ${sums.url}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== sums.sha256) throw new Error('image sums do not match the manifest')
  if (bytes.length !== blocks * 32) throw new Error(`image sums cover ${bytes.length / 32} blocks, the image has ${blocks}`)
  return bytes
}

export async function storeImage(a: StoreImageArgs, onProgress: (p: StoreImageProgress) => void, signal?: AbortSignal, resume?: Promise<void>): Promise<StoreImageResult> {
  const t0 = performance.now()
  const dir = await opfsDir(a.namespace, 'images')
  const cached = (file: string, size: number): StoreImageResult => {
    onProgress({ usable: { file, arriving: false } })
    return { bytes: size, ms: performance.now() - t0, cached: true, verified: false, file }
  }
  // The name is the content hash and a file only gets its name once verified.
  const have = await sizeOf(dir, a.name)
  if (have !== undefined && (a.bytes === undefined || have === a.bytes)) return cached(a.name, have)
  // One download of an image per origin: a second tab waits here and then finds it stored.
  return navigator.locks.request(`bat-image:${a.namespace}:${a.name}`, { signal }, async () => {
    const again = await sizeOf(dir, a.name)
    if (again !== undefined && (a.bytes === undefined || again === a.bytes)) return cached(a.name, again)
    if (again !== undefined) await dir.removeEntry(a.name).catch(() => {})
    const tmpName = partialOf(a.name)
    // A download an earlier session finished while its workers held the file open.
    if ((await sizeOf(dir, markOf(a.name))) !== undefined) {
      const size = await sizeOf(dir, tmpName)
      if (size !== undefined && (a.bytes === undefined || size === a.bytes)) {
        try {
          await ((await dir.getFileHandle(tmpName)) as any).move(a.name)
          await dir.removeEntry(markOf(a.name)).catch(() => {})
          return cached(a.name, size)
        } catch {
          // still held open somewhere: use it where it is
          return cached(tmpName, size)
        }
      }
      await dir.removeEntry(markOf(a.name)).catch(() => {})
    }
    return download(a, dir, onProgress, signal, t0, resume)
  })
}

async function download(a: StoreImageArgs, dir: FileSystemDirectoryHandle, onProgress: (p: StoreImageProgress) => void, signal: AbortSignal | undefined, t0: number, resume?: Promise<void>): Promise<StoreImageResult> {
  const tmpName = partialOf(a.name)
  const tmp = await dir.getFileHandle(tmpName, { create: true })
  // Shared with the workers that read the image while it arrives.
  const handle = (await (tmp as any).createSyncAccessHandle({ mode: 'readwrite-unsafe' })) as SyncHandle
  const blockBytes = a.sums?.blockBytes ?? 1 << 20
  const streaming = !!a.sums && a.bytes !== undefined
  let written = 0
  try {
    handle.truncate(0)
    const sumsReady = streaming ? fetchSums(a.sums!, Math.ceil(a.bytes! / blockBytes), signal) : undefined
    sumsReady?.catch(() => {})
    const hasher = !streaming && a.sha256 && a.nativeWasmUrl ? await sha256Stream(a.nativeWasmUrl) : undefined
    const res = await fetch(a.url, { signal })
    if (!res.ok || !res.body) throw new Error(`image download failed: HTTP ${res.status} ${a.url}`)
    const total = a.bytes ?? Number(res.headers.get('content-length') ?? 0)
    const sums = await sumsReady
    const reader = res.body.getReader()
    let announced = false
    // Verified blocks are written in order; a few digests run ahead of the write.
    let tail: Promise<void> = Promise.resolve()
    let inflight = 0
    let failed: unknown
    let index = 0
    const commit = (block: Uint8Array, at: number, blockIndex: number) => {
      const checked = sums
        ? crypto.subtle.digest('SHA-256', block).then((digest) => {
            const got = new Uint8Array(digest)
            const want = sums.subarray(blockIndex * 32, blockIndex * 32 + 32)
            for (let i = 0; i < 32; i++) if (got[i] !== want[i]) throw new Error(`image block ${blockIndex} does not match its checksum`)
          })
        : Promise.resolve()
      inflight++
      tail = tail
        .then(() => checked)
        .then(() => {
          let off = 0
          while (off < block.length) off += handle.write(block.subarray(off), { at: at + off })
          written = at + block.length
          onProgress({ loaded: written, total })
          if (streaming && !announced && written >= Math.min(a.headBytes ?? 0, a.bytes!)) {
            announced = true
            onProgress({ usable: { file: tmpName, arriving: true } })
          }
        })
        .catch((e) => {
          failed ??= e
        })
        .finally(() => {
          inflight--
        })
    }
    let block = new Uint8Array(blockBytes)
    let fill = 0
    let received = 0
    // Not reading is the pause: the response backs up to the server.
    let pauseAt = streaming && resume && a.firstBytes && a.firstBytes < a.bytes! ? Math.ceil(a.firstBytes / blockBytes) * blockBytes : 0
    for (;;) {
      if (pauseAt && received >= pauseAt) {
        pauseAt = 0
        await tail
        await Promise.race([resume, new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))])
      }
      const { done, value } = await reader.read()
      if (failed) throw failed
      if (done) break
      hasher?.update(value)
      let at = 0
      while (at < value.length) {
        const n = Math.min(value.length - at, blockBytes - fill)
        block.set(value.subarray(at, at + n), fill)
        fill += n
        at += n
        if (fill === blockBytes) {
          commit(block, received, index++)
          received += blockBytes
          block = new Uint8Array(blockBytes)
          fill = 0
          if (inflight >= 4) await tail
        }
      }
      if (a.bytes !== undefined && received + fill > a.bytes) throw new Error(`image download is longer than the ${a.bytes} bytes the manifest says`)
    }
    if (fill) {
      commit(block.subarray(0, fill), received, index++)
      received += fill
    }
    await tail
    if (failed) throw failed
    if (a.bytes !== undefined && received !== a.bytes) throw new Error(`image download is ${received} bytes, the manifest says ${a.bytes}`)
    if (hasher) {
      const got = hasher.hex()
      if (got !== a.sha256) throw new Error(`image hash mismatch: got ${got}, the manifest says ${a.sha256}`)
    }
    handle.flush()
    handle.close()
    // Durable and verified from here on, whatever its name.
    await dir.getFileHandle(markOf(a.name), { create: true })
    let file = tmpName
    // Once the partial file was announced it may be opened under that name at any
    // moment (or be open already, which makes a rename fail): it keeps the name for this
    // session and the next open renames it.
    if (!announced) {
      try {
        await (tmp as any).move(a.name)
        await dir.removeEntry(markOf(a.name)).catch(() => {})
        file = a.name
      } catch {
        // held open after all
      }
    }
    if (!announced) onProgress({ usable: { file, arriving: false } })
    return { bytes: received, ms: performance.now() - t0, cached: false, verified: streaming || !!hasher, file }
  } catch (e) {
    try {
      handle.close()
    } catch {
      // already closed
    }
    // Workers that mounted it early may still hold it; then the next download truncates it.
    await dir.removeEntry(tmpName).catch(() => {})
    throw e
  }
}

/**
 * Remove every stored image that is not one of `keep` (images of other hashes, abandoned
 * downloads). A file another tab's workers hold open cannot be removed and is left for
 * the next time; this runs only in the tab that holds the workspace.
 */
export async function collectImages(namespace: string, keep: string | string[]): Promise<string[]> {
  const dir = await opfsDir(namespace, 'images')
  const kept = new Set<string>()
  for (const name of Array.isArray(keep) ? keep : [keep]) for (const n of [name, partialOf(name), markOf(name)]) kept.add(n)
  const removed: string[] = []
  for await (const name of (dir as any).keys() as AsyncIterable<string>) {
    if (kept.has(name)) continue
    try {
      await dir.removeEntry(name)
      removed.push(name)
    } catch {
      // in use by another tab's worker: next time
    }
  }
  return removed
}
