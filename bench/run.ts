// Run the M0 kernel bench in the already-running Chrome through the
// browser-control CLI and print a summary (median over the runs).
//   bun bench/run.ts [--runs 5] [--fresh] [--workers 2] [--port 4101] [--session bat-kernel] [--json out.json]
// Needs: bench/pack.sh once (image + workload), crates/bat-kernel/build.sh,
// and `bun bench/server.ts <port>` running.
import { $ } from 'bun'

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? fallback : (process.argv[i + 1] ?? 'true')
}
const runs = Number(arg('runs', '5'))
const port = arg('port', '4101')
const session = arg('session', 'bat-kernel')
const workers = arg('workers', '2')
const fresh = process.argv.includes('--fresh')

const results: any[] = []
for (let i = 0; i < runs; i++) {
  // Only the first run of a --fresh series downloads; the rest reopen.
  const url = `http://127.0.0.1:${port}/bench/kernel-bench.html?workers=${workers}${fresh && i === 0 ? '&fresh=1' : ''}`
  const code = `await page.goto(${JSON.stringify(url)}); await page.waitForFunction(() => globalThis.benchResult, null, { timeout: 300000 }); return JSON.stringify(await page.evaluate(() => globalThis.benchResult))`
  const out = await $`browser-control execute --json --session ${session} ${code}`.quiet().text()
  const parsed = JSON.parse(out)
  if (!parsed.ok) throw new Error(`browser-control failed: ${out.slice(0, 2000)}`)
  const r = JSON.parse(parsed.value)
  if (!r.ok) throw new Error(`bench run ${i} failed: ${JSON.stringify(r).slice(0, 2000)}`)
  results.push(r)
  console.error(`run ${i + 1}/${runs}: mount ${r.mount.ms} ms, mixed warm ${r.mixedWarm.usPerCall} us/call, hit ${r.statHit.usPerCall}, miss ${r.statMiss.usPerCall}, big ${r.bigFile.coldMs}/${r.bigFile.warmMs} ms`)
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : +((s[s.length / 2 - 1] + s[s.length / 2]) / 2).toFixed(3)
}
const pick = (f: (r: any) => number) => {
  const xs = results.map(f)
  return { median: median(xs), min: Math.min(...xs), max: Math.max(...xs) }
}
const downloads = results.filter((r) => !r.store.cached)
const summary = {
  runs,
  workers: Number(workers),
  tree: results[0].tree,
  kernelWasmCompileMs: pick((r) => r.boot.compileMs),
  pageAttachMs: pick((r) => r.boot.attachMs),
  kerneldStartMs: pick((r) => r.boot.kerneldMs),
  imageDownloadToOpfs: downloads.length ? { bytes: downloads[0].store.bytes, ms: downloads[0].store.ms, mbPerS: downloads[0].store.mbPerS } : 'not measured (image already in OPFS; use --fresh)',
  mountMs: pick((r) => r.mount.ms),
  mountOpenHandleMs: pick((r) => r.mount.openHandleMs),
  mountIndexMs: pick((r) => r.mount.indexMs),
  bootToMountedMs: pick((r) => r.bootToMountedMs),
  mixed40kColdUsPerCall: pick((r) => r.mixedCold.usPerCall),
  mixed40kColdWallMs: pick((r) => r.mixedCold.wallMs),
  mixed40kColdOpfsChunkReads: pick((r) => r.mixedCold.opfsChunkReads),
  mixed40kWarmUsPerCall: pick((r) => r.mixedWarm.usPerCall),
  mixed40kWarmWallMs: pick((r) => r.mixedWarm.wallMs),
  mixed40kPooledUsPerCall: pick((r) => r.mixedPooled.usPerCall),
  mixed40kPooledWallMs: pick((r) => r.mixedPooled.wallMs),
  statHitUs: pick((r) => r.statHit.usPerCall),
  statMissUs: pick((r) => r.statMiss.usPerCall),
  kindOfHitUs: pick((r) => r.kindOfHit.usPerCall),
  smallReadWarmUs: pick((r) => r.smallRead.usPerCall),
  smallReadIntoWarmUs: pick((r) => r.smallReadInto.usPerCall),
  smallReadAvgBytes: Math.round(results[0].smallRead.bytes / results[0].smallRead.calls),
  realpathUs: pick((r) => r.realpath.usPerCall),
  overlayWrite2kUs: pick((r) => r.overlayWrite2k.usPerCall),
  pageStatHitUs: pick((r) => r.page.statHitUs),
  pageStatMissUs: pick((r) => r.page.statMissUs),
  bigFileBytes: results[0].bigFile.bytes,
  bigFileColdMs: pick((r) => r.bigFile.coldMs),
  bigFileWarmMs: pick((r) => r.bigFile.warmMs),
  spawnToFirstOutputMs: pick((r) => median(r.spawnToFirstOutputMs)),
  kernelMemoryMb: pick((r) => r.memoryMb),
}
console.log(JSON.stringify(summary, null, 2))
const jsonOut = arg('json')
if (jsonOut) await Bun.write(jsonOut, JSON.stringify({ summary, results }, null, 2))
