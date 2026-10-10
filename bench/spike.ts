// Spike: one kernel module, N workers plus the page, one shared memory.
// Each hammers a plain counter and a BTreeMap under a Rust lock; one more
// worker blocks in the kernel until the page wakes it.
import { attachKernel, createKernelMemory } from '../runtime/src/kernel/attach'

const out = document.getElementById('out')!
const WORKERS = 4
const N = 500_000
const MAP_N = 20_000

async function main() {
  const result: Record<string, unknown> = { crossOriginIsolated }
  const module = await WebAssembly.compileStreaming(fetch('/kernel.wasm'))
  const memory = createKernelMemory()
  const k = await attachKernel({ module, memory, canBlock: false, first: true })
  k.x.bat_spike_reset()

  const spawn = (role: string, index: number) =>
    new Promise<{ worker: Worker; send: (m: unknown) => Promise<any> }>((resolve) => {
      const worker = new Worker('/bench/spike-worker.ts', { type: 'module' })
      const send = (m: unknown) =>
        new Promise<any>((res) => {
          worker.onmessage = (e) => res(e.data)
          worker.postMessage(m)
        })
      worker.onmessage = () => resolve({ worker, send })
      worker.postMessage({ type: 'attach', module, memory, role, index })
    })

  const workers = await Promise.all(Array.from({ length: WORKERS }, (_, i) => spawn('hammer', i)))
  const blocker = await spawn('blocker', 99)
  const blocked = blocker.send({ type: 'block' })

  const t0 = performance.now()
  const runs = workers.map((w, i) => w.send({ type: 'hammer', n: N, mapBase: (i + 1) * 1_000_000, mapN: MAP_N }))
  // The page takes the same lock at the same time, spinning instead of waiting.
  k.x.bat_spike_count(N)
  k.x.bat_spike_map(0, MAP_N)
  const reports = await Promise.all(runs)
  const ms = performance.now() - t0

  const counter = k.x.bat_spike_counter()
  const mapLen = k.x.bat_spike_map_len()
  const expectCounter = (WORKERS + 1) * N
  const expectMap = (WORKERS + 1) * (MAP_N / 2)

  const stillBlocked = await Promise.race([blocked.then(() => false), new Promise((r) => setTimeout(() => r(true), 200))])
  const tw = performance.now()
  k.x.bat_spike_open(42)
  const woke = await blocked
  result.counter = { got: counter, expect: expectCounter, ok: counter === expectCounter }
  result.map = { got: mapLen, expect: expectMap, ok: mapLen === expectMap }
  result.block = { stillBlockedBeforeWake: stillBlocked, value: woke.value, wakeMs: +(performance.now() - tw).toFixed(2), ok: stillBlocked === true && woke.value === 42 }
  result.tids = [k.tid, ...reports.map((r) => r.tid), woke.tid]
  result.ms = +ms.toFixed(1)
  result.nsPerLockedIncrement = +((ms * 1e6) / expectCounter).toFixed(1)
  result.memoryBytes = memory.buffer.byteLength
  result.ok = (result.counter as any).ok && (result.map as any).ok && (result.block as any).ok
  ;(globalThis as any).spikeResult = result
  out.textContent = JSON.stringify(result, null, 2)
}
main().catch((e) => {
  ;(globalThis as any).spikeResult = { ok: false, error: String(e?.stack ?? e) }
  out.textContent = String(e?.stack ?? e)
})
