// The dependency image in OPFS: fetch-or-reuse by content hash. Runs in a
// worker (the bridge worker) because it writes through a sync access handle
// and hashes 200+ MB; the page only sees progress messages.
//
// Transport compression needs no code here: the server handler answers with
// `Content-Encoding: zstd` or `br` when a precompressed sibling exists and the
// browser decodes it, so this stream is always the image's own bytes.
import { opfsDir, type SyncHandle } from '../kernel/opfs'

export interface StoreImageArgs {
  namespace: string
  /** OPFS file name; content-addressed (`image-<hash>.batimg`). */
  name: string
  url: string
  /** Expected size and lower-case hex SHA-256 of the image. */
  bytes?: number
  sha256?: string
  /** bat_node_native.wasm: streaming SHA-256 (WebCrypto cannot hash incrementally). */
  nativeWasmUrl?: string
}

export interface StoreImageResult {
  bytes: number
  ms: number
  cached: boolean
  verified: boolean
}

interface Hasher {
  update(chunk: Uint8Array): void
  hex(): string
}

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
      return Array.from(new Uint8Array(x.memory.buffer, buf, n), (b) => b.toString(16).padStart(2, '0')).join('')
    },
  }
}

export async function storeImage(a: StoreImageArgs, onProgress: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<StoreImageResult> {
  const t0 = performance.now()
  const dir = await opfsDir(a.namespace, 'images')
  try {
    const have = await (await dir.getFileHandle(a.name)).getFile()
    // The name is the content hash and a file only gets its name once verified.
    if (a.bytes === undefined || have.size === a.bytes) return { bytes: have.size, ms: performance.now() - t0, cached: true, verified: false }
    await dir.removeEntry(a.name)
  } catch {
    // not there
  }
  const tmpName = `${a.name}.partial`
  const tmp = await dir.getFileHandle(tmpName, { create: true })
  const handle = (await (tmp as any).createSyncAccessHandle()) as SyncHandle
  const hasher = a.sha256 && a.nativeWasmUrl ? await sha256Stream(a.nativeWasmUrl) : undefined
  let bytes = 0
  try {
    handle.truncate(0)
    const res = await fetch(a.url, { signal })
    if (!res.ok || !res.body) throw new Error(`image download failed: HTTP ${res.status} ${a.url}`)
    const total = a.bytes ?? Number(res.headers.get('content-length') ?? 0)
    const reader = res.body.getReader()
    let reported = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      let off = 0
      while (off < value.length) off += handle.write(value.subarray(off), { at: bytes + off })
      hasher?.update(value)
      bytes += value.length
      if (bytes - reported >= 1 << 20) {
        reported = bytes
        onProgress(bytes, total)
      }
    }
    handle.flush()
    onProgress(bytes, total || bytes)
  } catch (e) {
    handle.close()
    await dir.removeEntry(tmpName).catch(() => {})
    throw e
  }
  handle.close()
  if (a.bytes !== undefined && bytes !== a.bytes) {
    await dir.removeEntry(tmpName).catch(() => {})
    throw new Error(`image download is ${bytes} bytes, the manifest says ${a.bytes}`)
  }
  if (hasher) {
    const got = hasher.hex()
    if (got !== a.sha256) {
      await dir.removeEntry(tmpName).catch(() => {})
      throw new Error(`image hash mismatch: got ${got}, the manifest says ${a.sha256}`)
    }
  }
  await (tmp as any).move(a.name)
  return { bytes, ms: performance.now() - t0, cached: false, verified: !!hasher }
}

/** Remove every stored image except `keep` (images of other hashes, abandoned downloads). */
export async function collectImages(namespace: string, keep: string): Promise<string[]> {
  const dir = await opfsDir(namespace, 'images')
  const removed: string[] = []
  for await (const name of (dir as any).keys() as AsyncIterable<string>) {
    if (name === keep) continue
    try {
      await dir.removeEntry(name)
      removed.push(name)
    } catch {
      // in use by another tab's worker: next time
    }
  }
  return removed
}
