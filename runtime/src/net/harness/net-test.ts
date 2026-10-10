// Endpoint client against the raw kernel responder (no Node runtime involved).
import { bootKernel } from '../../kernel/boot'
import { createReactor } from '../../host/reactor'
import { createEndpoints } from '../../host/endpoint'
import { wsConnect } from '../ws-client'

const out = document.getElementById('out')!
const results: Record<string, unknown> = {}
const log = (name: string, value: unknown) => {
  results[name] = value
  out.textContent = JSON.stringify(results, null, 2)
}
const here = (p: string) => new URL(p, import.meta.url).href

async function main() {
  const booted = await bootKernel({
    wasmUrl: '/kernel.wasm',
    kerneldUrl: here('../../kernel/kerneld.ts'),
    processWorkerUrl: here('../../kernel/process-worker.ts'),
    warmSpare: false,
  })
  const { kernel } = booted
  const io = createReactor(kernel)
  const closed = new AbortController()
  const { endpoint } = createEndpoints({ kernel, io }, location.origin, closed.signal)
  const ep = endpoint(8080)

  const t0 = performance.now()
  const ready = ep.ready().then(() => performance.now() - t0)
  await new Promise((r) => setTimeout(r, 50))
  const worker = new Worker(here('./responder-worker.ts'), { type: 'module' })
  worker.postMessage({ module: booted.module, memory: booted.memory, port: 8080 })
  log('readyAfterMs', Math.round(await ready))

  let r = await ep.fetch('/hello')
  log('hello', { status: r.status, type: r.headers.get('content-type'), text: await r.text() })

  r = await ep.fetch('/echo', { method: 'POST', body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json' } })
  log('echo', { status: r.status, method: r.headers.get('x-method'), json: await r.json() })

  // streamed request body
  const parts = ['one,', 'two,', 'three']
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      const p = parts.shift()
      if (!p) return c.close()
      await new Promise((r) => setTimeout(r, 10))
      c.enqueue(new TextEncoder().encode(p))
    },
  })
  // The responder's /echo needs a length: this goes out chunked and comes back whole.
  r = await ep.fetch('/echo', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
  log('echoStream', await r.text())

  r = await ep.fetch('/redirect')
  log('redirect', { status: r.status, location: r.headers.get('location') })
  await r.arrayBuffer()

  r = await ep.fetch('/missing')
  log('missing', { status: r.status, text: await r.text() })

  // SSE: events must arrive one by one while other requests run.
  const sseStart = performance.now()
  const sse = await ep.fetch('/sse?n=20&ms=100')
  const reader = sse.body!.pipeThrough(new TextDecoderStream()).getReader()
  const arrivals: number[] = []
  const sseDone = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (const _ of value.matchAll(/data:/g)) arrivals.push(Math.round(performance.now() - sseStart))
    }
  })()

  // 200 concurrent small requests while the SSE stream is open.
  const c0 = performance.now()
  const texts = await Promise.all(Array.from({ length: 200 }, () => ep.fetch('/hello').then((x) => x.text())))
  log('concurrent200', { ok: texts.every((t) => t.startsWith('hello ')), ms: Math.round(performance.now() - c0) })

  // sequential per-request overhead
  const samples: number[] = []
  for (let i = 0; i < 300; i++) {
    const s = performance.now()
    await (await ep.fetch('/hello')).arrayBuffer()
    samples.push(performance.now() - s)
  }
  samples.sort((a, b) => a - b)
  log('sequentialMs', { median: +samples[150].toFixed(3), p90: +samples[270].toFixed(3), min: +samples[0].toFixed(3) })

  for (const path of ['/big?mb=30', '/chunked?mb=30']) {
    const b0 = performance.now()
    const big = await ep.fetch(path)
    const ttfb = performance.now() - b0
    let bytes = 0
    let bad = 0
    const br = big.body!.getReader()
    for (;;) {
      const { done, value } = await br.read()
      if (done) break
      for (let i = 0; i < value.length; i += 4099) if (value[i] !== ((bytes + i) & 255)) bad++
      bytes += value.length
    }
    const ms = performance.now() - b0
    log(path, { bytes, bad, ttfbMs: +ttfb.toFixed(2), ms: Math.round(ms), mbPerS: Math.round(bytes / 1048576 / (ms / 1000)) })
  }

  // abort closes the stream
  const ac = new AbortController()
  const ab = await ep.fetch('/sse?n=1000&ms=50', { signal: ac.signal })
  const abReader = ab.body!.getReader()
  await abReader.read()
  ac.abort()
  log('abort', await abReader.read().then(() => 'no error', (e) => e.name))

  await sseDone
  const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i])
  log('sse', { events: arrivals.length, first: arrivals[0], last: arrivals.at(-1), maxGap: Math.max(...gaps), minGap: Math.min(...gaps) })

  // WebSocket through the kernel codec
  const wsResult = await new Promise<unknown>((resolve) => {
    const got: unknown[] = []
    const big = new Uint8Array(700_000).map((_, i) => i & 255)
    const sent = performance.now()
    const ws = wsConnect({ kernel, io }, 8080, '/ws', {}, {
      open() {
        ws.send('ping-1')
        ws.send(big)
      },
      message(data) {
        if (typeof data === 'string') got.push({ text: data, ms: +(performance.now() - sent).toFixed(2) })
        else {
          got.push({ binary: data.length, same: data.every((v, i) => v === (i & 255)) })
          ws.close(1000, 'bye')
        }
      },
      close(code, reason, clean) {
        resolve({ got, code, reason, clean })
      },
      error(m) {
        got.push({ error: m })
      },
    })
  })
  log('ws', wsResult)

  // refused
  log('refused', await endpoint(9).fetch('/').then(() => 'ok', (e) => `${e.name}: ${e.cause?.code}`))
  log('done', true)
  ;(window as any).__results = results
}
main().catch((e) => log('error', String(e?.stack ?? e)))
