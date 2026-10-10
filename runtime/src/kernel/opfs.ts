// OPFS layout used by the kernel host side. Everything lives under one
// directory per namespace so several apps on an origin do not collide:
//   bat/<namespace>/images/<name>        immutable image files
//   bat/<namespace>/overlay/journal      append-only journal frames
//   bat/<namespace>/overlay/snap-a|b     alternating snapshots

export interface SyncHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number
  write(buffer: ArrayBufferView, options?: { at?: number }): number
  truncate(size: number): void
  getSize(): number
  flush(): void
  close(): void
}

export async function opfsDir(namespace: string, ...parts: string[]): Promise<FileSystemDirectoryHandle> {
  let dir = await navigator.storage.getDirectory()
  for (const part of ['bat', namespace, ...parts]) {
    dir = await dir.getDirectoryHandle(part, { create: true })
  }
  return dir
}

export async function imageExists(namespace: string, name: string): Promise<number | undefined> {
  const dir = await opfsDir(namespace, 'images')
  try {
    const h = await dir.getFileHandle(name)
    return (await h.getFile()).size
  } catch {
    return undefined
  }
}

async function openImage(namespace: string, name: string): Promise<SyncHandle> {
  const dir = await opfsDir(namespace, 'images')
  const h = await dir.getFileHandle(name)
  try {
    return (await (h as any).createSyncAccessHandle({ mode: 'read-only' })) as SyncHandle
  } catch (e) {
    // An image that is still being downloaded (`<name>.partial`) is held by its writer
    // in the shared read-write mode, which excludes read-only handles: join that mode.
    if ((e as DOMException)?.name !== 'NoModificationAllowedError') throw e
    return (await (h as any).createSyncAccessHandle({ mode: 'readwrite-unsafe' })) as SyncHandle
  }
}
const early = new Map<string, Promise<SyncHandle>>()
/**
 * Start opening an image this worker will be asked to open once it is mounted (the host
 * knows the name from the manifest before the kernel exists). An image file carries its
 * name only when complete, so a file that is there can be opened; one that is not yet
 * (first download) is simply opened later.
 */
export function preopenImage(namespace: string, name: string): void {
  const key = `${namespace}/${name}`
  if (early.has(key)) return
  const opening = openImage(namespace, name)
  opening.catch(() => {
    if (early.get(key) === opening) early.delete(key)
  })
  early.set(key, opening)
}
/** Read-only sync handle; many workers may hold one on the same file. Workers only. */
export async function openImageHandle(namespace: string, name: string): Promise<SyncHandle> {
  const key = `${namespace}/${name}`
  const opening = early.get(key)
  if (opening) {
    early.delete(key)
    try {
      return await opening
    } catch {
      // not there when asked early
    }
  }
  return openImage(namespace, name)
}

/**
 * Stream `url` into OPFS as image `name`. Written under a temporary name and
 * moved into place when complete, so a partial download is never mounted.
 * Workers only (sync access handle writes).
 */
export async function storeImage(
  namespace: string,
  name: string,
  url: string,
  onProgress?: (bytes: number) => void,
): Promise<{ bytes: number; ms: number }> {
  const t0 = performance.now()
  const dir = await opfsDir(namespace, 'images')
  const tmpName = `${name}.partial`
  const tmp = await dir.getFileHandle(tmpName, { create: true })
  const handle = (await (tmp as any).createSyncAccessHandle()) as SyncHandle
  let bytes = 0
  try {
    handle.truncate(0)
    const res = await fetch(url)
    if (!res.ok || !res.body) throw new Error(`image download failed: ${res.status} ${url}`)
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      let off = 0
      while (off < value.length) off += handle.write(value.subarray(off), { at: bytes + off })
      bytes += value.length
      onProgress?.(bytes)
    }
    handle.flush()
  } finally {
    handle.close()
  }
  await (tmp as any).move(name)
  return { bytes, ms: performance.now() - t0 }
}

export async function removeImage(namespace: string, name: string): Promise<void> {
  const dir = await opfsDir(namespace, 'images')
  await dir.removeEntry(name).catch(() => {})
}

export function fnv1a32(bytes: Uint8Array): number {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
