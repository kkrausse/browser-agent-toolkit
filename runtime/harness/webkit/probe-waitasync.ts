// Does a worker sleeping in Atomics.waitAsync wake promptly when another worker notifies?
//   bun runtime/harness/webkit/probe-waitasync.ts [webkit|chrome] [rounds=200]
// A "waiter" worker loops on waitAsync (like kerneld's supervisor loop and a process's
// event loop); a "pinger" worker bumps the word, notifies, and blocks until the waiter
// answers, with a pause of 0-60 ms between rounds. Variants: with a 250 ms timeout on the
// wait (kerneld), without one (process loop), and without one plus a MessagePort ping
// sent next to the notify. A round the waiter has not answered after 3 s is counted as never.
import { webkit, chromium } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const worker = `
self.onmessage = (e) => {
  const m = e.data
  const i32 = new Int32Array(m.sab)
  if (m.op === 'waiter') {
    if (m.port) m.port.onmessage = () => {}
    ;(async () => {
      for (;;) {
        const seen = Atomics.load(i32, 0)
        if (seen !== Atomics.load(i32, 1)) { Atomics.store(i32, 1, seen); Atomics.notify(i32, 1); continue }
        const r = m.timeout ? Atomics.waitAsync(i32, 0, seen, m.timeout) : Atomics.waitAsync(i32, 0, seen)
        if (r.async) await r.value
      }
    })()
    self.postMessage({ waiting: true })
  } else {
    const times = []
    const idle = new Int32Array(new SharedArrayBuffer(4))
    for (let i = 0; i < m.rounds; i++) {
      Atomics.wait(idle, 0, 0, Math.random() * 60)
      const t = performance.now()
      const v = Atomics.add(i32, 0, 1) + 1
      Atomics.notify(i32, 0)
      if (m.port) m.port.postMessage(0)
      const give = performance.now() + 3000
      let last = Atomics.load(i32, 1)
      while (last !== v && performance.now() < give) { Atomics.wait(i32, 1, last, 3000); last = Atomics.load(i32, 1) }
      times.push(last === v ? performance.now() - t : Infinity)
    }
    const sorted = [...times].sort((a, b) => a - b)
    self.postMessage({ median: sorted[sorted.length >> 1], max: sorted.at(-1), over50ms: times.filter((x) => x > 50 && x < Infinity).map((x) => Math.round(x)), neverWithin3s: times.filter((x) => x === Infinity).length })
  }
}`
const h = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }
const srv = Bun.serve({ port: 0, fetch: (r) => new URL(r.url).pathname === '/w.js' ? new Response(worker, { headers: { ...h, 'content-type': 'text/javascript' } }) : new Response('<!doctype html><title>p</title>', { headers: { ...h, 'content-type': 'text/html' } }) })
const which = process.argv[2] ?? 'webkit'
const rounds = Number(process.argv[3] ?? 200)
const b = await (which === 'webkit' ? webkit : chromium).launchPersistentContext(mkdtempSync(join(tmpdir(), 'bat-probe-')), which === 'webkit' ? {} : { channel: 'chrome', headless: true })
const page = await b.newPage()
await page.goto(`http://localhost:${srv.port}/`)
const r = await page.evaluate(async (rounds) => {
  const ask = (w: Worker, m: any, transfer: Transferable[] = []) => new Promise<any>((res) => { w.onmessage = (e) => res(e.data); w.postMessage(m, transfer) })
  const out: any = {}
  for (const [name, timeout, port] of [['timeout250', 250, false], ['noTimeout', 0, false], ['noTimeoutPlusPort', 0, true]] as const) {
    const sab = new SharedArrayBuffer(16)
    const ch = port ? new MessageChannel() : undefined
    const waiter = new Worker('/w.js'), pinger = new Worker('/w.js')
    await ask(waiter, { op: 'waiter', sab, timeout, port: ch?.port1 }, ch ? [ch.port1] : [])
    out[name] = await ask(pinger, { op: 'pinger', sab, rounds, port: ch?.port2 }, ch ? [ch.port2] : [])
    waiter.terminate(); pinger.terminate()
  }
  return out
}, rounds)
console.log(which, JSON.stringify(r))
await b.close(); srv.stop(true)
