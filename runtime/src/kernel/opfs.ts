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

/** Read-only sync handle; many workers may hold one on the same file. Workers only. */
export async function openImageHandle(namespace: string, name: string): Promise<SyncHandle> {
  const dir = await opfsDir(namespace, 'images')
  const h = await dir.getFileHandle(name)
  return (await (h as any).createSyncAccessHandle({ mode: 'read-only' })) as SyncHandle
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
