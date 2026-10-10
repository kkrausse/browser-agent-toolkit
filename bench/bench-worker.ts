// A benchmark worker: attaches to the kernel like any process worker would
// (own instance, own read-only handle on the image) and runs call loops.
import { attachKernel } from '../runtime/src/kernel/attach'
import { createKernel, type Kernel } from '../runtime/src/kernel/kernel'
import { openImageHandle, type SyncHandle } from '../runtime/src/kernel/opfs'

let k: Kernel
const handles: (SyncHandle | undefined)[] = []
let hits: string[] = []
let misses: string[] = []

self.onmessage = async (e: MessageEvent) => {
  const m = e.data
  if (m.type === 'attach') {
    const inst = await attachKernel({
      module: m.module,
      memory: m.memory,
      canBlock: true,
      host: { imageRead: (image, offset, dst) => handles[image]?.read(dst, { at: offset }) ?? -11 },
    })
    k = createKernel(inst)
    k.x.bat_host_proc_new()
    const names = k.imageNames()
    for (let id = 0; id < names.length; id++) if (names[id]) handles[id] = await openImageHandle(m.namespace, names[id]!)
    hits = m.hits
    misses = m.misses
    postMessage({ type: 'ready' })
    return
  }
  if (m.type === 'run') {
    const n: number = m.n
    const off: number = m.offset
    let found = 0
    let bytes = 0
    const H = hits.length
    const M = misses.length
    const t0 = performance.now()
    if (m.kind === 'mixed') {
      // per 4 calls: 1 small read, 1 stat hit, 2 stat misses
      for (let i = 0; i < n; i++) {
        const j = off + i
        const r = i & 3
        if (r === 0) bytes += k.readFile(hits[j % H]).length
        else if (r === 1) found += k.tryStat(hits[(j * 7) % H]) ? 1 : 0
        else found += k.tryStat(misses[j % M]) ? 1 : 0
      }
    } else if (m.kind === 'hit') {
      for (let i = 0; i < n; i++) found += k.tryStat(hits[(off + i) % H]) ? 1 : 0
    } else if (m.kind === 'miss') {
      for (let i = 0; i < n; i++) found += k.tryStat(misses[(off + i) % M]) ? 1 : 0
    } else if (m.kind === 'kindOf') {
      for (let i = 0; i < n; i++) found += k.kindOf(hits[(off + i) % H]) >= 0 ? 1 : 0
    } else if (m.kind === 'mixedPooled') {
      // the same mix with what a Node layer would do: a pooled read buffer and raw stat fields
      const pool = new Uint8Array(65536)
      for (let i = 0; i < n; i++) {
        const j = off + i
        const r = i & 3
        if (r === 0) bytes += k.readFileInto(hits[j % H], pool)
        else if (r === 1) found += k.statRaw(hits[(j * 7) % H]) === 0 ? 1 : 0
        else found += k.statRaw(misses[j % M]) === 0 ? 1 : 0
      }
    } else if (m.kind === 'readInto') {
      const pool = new Uint8Array(65536)
      for (let i = 0; i < n; i++) bytes += k.readFileInto(hits[(off + i) % H], pool)
    } else if (m.kind === 'read') {
      for (let i = 0; i < n; i++) bytes += k.readFile(hits[(off + i) % H]).length
    } else if (m.kind === 'realpath') {
      for (let i = 0; i < n; i++) found += k.realpath(hits[(off + i) % H]).length > 0 ? 1 : 0
    } else if (m.kind === 'big') {
      bytes = k.readFile(m.path).length
    } else if (m.kind === 'write') {
      const data = new Uint8Array(2000).fill(120)
      for (let i = 0; i < n; i++) k.writeFile(`/workspace/bench-${off}-${i % 500}.txt`, data)
    }
    postMessage({ type: 'done', ms: performance.now() - t0, n, found, bytes })
  }
}
