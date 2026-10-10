// Static server for the net harness pages (COOP/COEP, .ts bundled on request).
//   bun runtime/src/net/harness/server.ts [port]
// /real/* stands for "the page's real server" in hostPaths and host.internal checks.
import { join, normalize } from 'node:path'

const root = normalize(join(import.meta.dir, '../../../..'))
const port = Number(process.argv[2] ?? 4103)
const wasm = process.env.BAT_KERNEL_WASM ?? join(root, 'target-net/wasm32-wasip1-threads/release/bat_kernel.wasm')
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Service-Worker-Allowed': '/',
  'Cache-Control': 'no-store',
}
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' }

Bun.serve({
  port,
  hostname: '0.0.0.0',
  idleTimeout: 240,
  async fetch(req) {
    const url = new URL(req.url)
    const path = decodeURIComponent(url.pathname)
    if (path === '/kernel.wasm') return new Response(Bun.file(wasm), { headers: { ...headers, 'Content-Type': 'application/wasm' } })
    if (path.startsWith('/real/')) {
      return Response.json({ real: true, path, method: req.method, cookie: req.headers.get('cookie'), big: req.headers.get('x-big')?.length ?? 0 }, { headers })
    }
    const file = normalize(join(root, path))
    if (!file.startsWith(root)) return new Response('forbidden', { status: 403, headers })
    if (file.endsWith('.ts')) {
      const out = await Bun.build({ entrypoints: [file], target: 'browser', format: url.searchParams.has('iife') ? 'iife' : 'esm' })
      if (!out.success) return new Response(out.logs.map(String).join('\n'), { status: 500, headers })
      return new Response(await out.outputs[0].text(), { headers: { ...headers, 'Content-Type': 'text/javascript' } })
    }
    const f = Bun.file(file)
    if (!(await f.exists())) return new Response('not found', { status: 404, headers })
    const ext = file.slice(file.lastIndexOf('.'))
    return new Response(f, { headers: { ...headers, 'Content-Type': types[ext] ?? 'application/octet-stream' } })
  },
})
console.log(`net harness on http://localhost:${port}/runtime/src/net/harness/net-test.html`)
