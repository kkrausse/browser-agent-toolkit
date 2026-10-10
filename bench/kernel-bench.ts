// M0 measurements. One page load = one run.
//   ?fresh=1   delete the image from OPFS first, so (a) measures the download
//   ?workers=N number of concurrent benchmark workers (default 2)
import { bootKernel } from '../runtime/src/kernel/boot'
import { POLLHUP, POLLIN, TOKEN_CHILD } from '../runtime/src/kernel/kernel'

const out = document.getElementById('out')!
const q = new URLSearchParams(location.search)
const IMAGE = 'todo-node-modules.batimg'
const NM = '/workspace/node_modules'
const WORKERS = Number(q.get('workers') ?? 2)
const CALLS = 40_000

const round = (v: number, d = 2) => +v.toFixed(d)

async function main() {
  const r: Record<string, any> = { userAgent: navigator.userAgent, workers: WORKERS }
  const workload = await (await fetch('/bench/dist/paths.json')).json()
  let hits: string[] = workload.sample.map((p: string) => `${NM}/${p}`)
  // Misses shaped like module resolution probes: a missing extension beside a
  // real file, a missing node_modules directory deep in a real package, and a
  // package that does not exist at all.
  const misses: string[] = hits.flatMap((p, i) => {
    const dir = p.slice(0, p.lastIndexOf('/'))
    return i % 3 === 0 ? [`${p}.js`] : i % 3 === 1 ? [`${dir}/node_modules/dep-${i}/package.json`] : [`${NM}/missing-pkg-${i}/package.json`]
  })
  r.tree = { files: workload.files, bytes: workload.bytes, symlinks: workload.symlinks, samplePaths: hits.length }

  const tBoot = performance.now()
  const boot = await bootKernel({
    wasmUrl: '/kernel.wasm',
    kerneldUrl: '/runtime/src/kernel/kerneld.ts',
    processWorkerUrl: '/runtime/src/kernel/process-worker.ts',
    runnerUrl: '/bench/demo-runner.ts',
    namespace: 'kbench',
  })
  const k = boot.kernel
  ;(globalThis as any).k = k
  ;(globalThis as any).hits = hits
  r.boot = { compileMs: round(boot.timings.compileMs), attachMs: round(boot.timings.attachMs), kerneldMs: round(boot.timings.kerneldMs) }

  // (a) image into OPFS
  if (q.get('fresh')) await boot.kerneld('removeImage', { name: IMAGE })
  const stored = await boot.storeImage(IMAGE, `/bench/dist/${IMAGE}`)
  r.store = { ...stored, ms: round(stored.ms), mbPerS: stored.cached ? null : round(stored.bytes / 1e6 / (stored.ms / 1000), 1) }

  // (b) mount
  const mounted = await boot.mountImage(IMAGE, NM)
  r.mount = { entries: mounted.entries, ms: round(mounted.ms), openHandleMs: round(mounted.openHandleMs), indexMs: round(mounted.indexMs) }
  r.bootToMountedMs = round(performance.now() - tBoot - (stored.cached ? 0 : stored.ms))
  r.firstStatAfterMount = k.tryStat(hits[0])?.size

  // workers
  const spawnWorker = () =>
    new Promise<(m: object) => Promise<any>>((resolve) => {
      const w = new Worker('/bench/bench-worker.ts', { type: 'module' })
      const send = (m: object) =>
        new Promise<any>((res) => {
          w.onmessage = (e) => res(e.data)
          w.postMessage(m)
        })
      w.onmessage = () => resolve(send)
      w.postMessage({ type: 'attach', module: boot.module, memory: boot.memory, namespace: 'kbench', hits, misses })
    })
  const tW = performance.now()
  const workers = await Promise.all(Array.from({ length: WORKERS }, spawnWorker))
  r.benchWorkersReadyMs = round(performance.now() - tW)

  // (d) one 27 MB file, cold then warm, from one worker
  const big = `${NM}/${workload.largest.path}`
  const cold = await workers[0]({ type: 'run', kind: 'big', path: big })
  const warm = await workers[0]({ type: 'run', kind: 'big', path: big })
  r.bigFile = { bytes: cold.bytes, coldMs: round(cold.ms), warmMs: round(warm.ms), coldMbPerS: round(cold.bytes / 1e6 / (cold.ms / 1000)), warmMbPerS: round(warm.bytes / 1e6 / (warm.ms / 1000)) }

  // (c) 40,000 mixed calls from all workers at once
  const pass = async (kind: string, total: number) => {
    const per = Math.floor(total / WORKERS)
    const t0 = performance.now()
    const res = await Promise.all(workers.map((send, i) => send({ type: 'run', kind, n: per, offset: i * 1000 })))
    const wall = performance.now() - t0
    return {
      calls: per * WORKERS,
      wallMs: round(wall),
      // each worker's own elapsed time divided by its own call count
      usPerCall: round((res.reduce((s, x) => s + x.ms, 0) / (per * WORKERS)) * 1000, 3),
      callsPerSecond: Math.round((per * WORKERS) / (wall / 1000)),
      found: res.reduce((s, x) => s + x.found, 0),
      bytes: res.reduce((s, x) => s + x.bytes, 0),
    }
  }
  const imgBefore = k.imageStats(mounted.id)
  r.mixedCold = await pass('mixed', CALLS)
  const imgAfter = k.imageStats(mounted.id)
  r.mixedCold.opfsChunkReads = imgAfter.hostReads - imgBefore.hostReads
  r.mixedWarm = await pass('mixed', CALLS)
  r.mixedPooled = await pass('mixedPooled', CALLS)
  // breakdown by call type, same concurrency, warm
  r.statHit = await pass('hit', CALLS)
  r.statMiss = await pass('miss', CALLS)
  r.kindOfHit = await pass('kindOf', CALLS)
  r.smallRead = await pass('read', CALLS)
  r.smallReadInto = await pass('readInto', CALLS)
  r.realpath = await pass('realpath', CALLS)
  r.overlayWrite2k = await pass('write', 10_000)
  r.image = k.imageStats(mounted.id)

  // the page's own instance (cannot block), single thread
  {
    const n = 20_000
    let t0 = performance.now()
    let found = 0
    for (let i = 0; i < n; i++) found += k.tryStat(hits[i % hits.length]) ? 1 : 0
    const hitMs = performance.now() - t0
    t0 = performance.now()
    for (let i = 0; i < n; i++) found += k.tryStat(misses[i % misses.length]) ? 1 : 0
    const missMs = performance.now() - t0
    t0 = performance.now()
    const names = k.readdir(`${NM}/.bun`)
    const readdirMs = performance.now() - t0
    r.page = { statHitUs: round((hitMs / n) * 1000, 3), statMissUs: round((missMs / n) * 1000, 3), readdirBunEntries: names.length, readdirMs: round(readdirMs, 3), found }
  }

  // spawn latency with the warm spare: request -> first byte on the child's stdout
  {
    const exits = new Map<number, number>()
    const readable = new Map<number, () => void>()
    const stop = k.runEvents((token, mask) => {
      if (token >= TOKEN_CHILD) exits.set(token - TOKEN_CHILD, mask)
      else readable.get(token)?.()
    })
    const samples: number[] = []
    for (let i = 0; i < 5; i++) {
      await boot.kerneld('spareReady')
      const t0 = performance.now()
      const p = k.spawn({ exec: '/bin/demo', argv: ['demo', 'echo'], env: { GREETING: 'x' }, stdio: ['pipe', 'pipe', 'inherit'] })
      const first = await new Promise<number>((resolve) => {
        const buf = new Uint8Array(4096)
        readable.set(p.stdio[1], () => {
          if (k.readRaw(p.stdio[1], buf) > 0) resolve(performance.now() - t0)
        })
        k.subscribe(p.stdio[1], POLLIN | POLLHUP)
      })
      samples.push(round(first))
      k.close(p.stdio[0])
      while (!exits.has(p.pid)) await new Promise((res) => setTimeout(res, 1))
      k.waitpid(p.pid, true)
      k.close(p.stdio[1])
    }
    stop()
    r.spawnToFirstOutputMs = samples
  }
  r.memoryMb = round(boot.memory.buffer.byteLength / 1e6, 1)
  r.ok = r.mixedWarm.found === r.mixedCold.found && r.statHit.found === r.statHit.calls && r.statMiss.found === 0
  return r
}

main()
  .then((r) => {
    ;(globalThis as any).benchResult = r
    out.textContent = JSON.stringify(r, null, 2)
  })
  .catch((e) => {
    ;(globalThis as any).benchResult = { ok: false, error: String(e?.stack ?? e) }
    out.textContent = String(e?.stack ?? e)
  })
