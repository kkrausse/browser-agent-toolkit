// Static server for the kernel harness pages. Sets the cross-origin isolation
// headers SharedArrayBuffer needs, bundles .ts on request, and serves the
// kernel wasm and packed images with Range support.
//   bun bench/server.ts [port]
import { join, normalize } from 'node:path'

const root = normalize(join(import.meta.dir, '..'))
const port = Number(process.argv[2] ?? process.env.PORT ?? 4101)
const wasmPath =
  process.env.BAT_KERNEL_WASM ?? join(root, 'target-kernel/wasm32-wasip1-threads/release/bat_kernel.wasm')

const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
}
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
}

Bun.serve({
  port,
  hostname: '0.0.0.0',
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url)
    let path = decodeURIComponent(url.pathname)
    if (path === '/') path = '/bench/index.html'
    if (path === '/kernel.wasm') {
      return new Response(Bun.file(wasmPath), { headers: { ...headers, 'Content-Type': 'application/wasm' } })
    }
    const file = normalize(join(root, path))
    if (!file.startsWith(root)) return new Response('forbidden', { status: 403, headers })
    if (file.endsWith('.ts')) {
      const out = await Bun.build({ entrypoints: [file], target: 'browser', format: 'esm', sourcemap: 'inline' })
      if (!out.success) {
        return new Response(out.logs.map(String).join('\n'), { status: 500, headers })
      }
      return new Response(await out.outputs[0].text(), { headers: { ...headers, 'Content-Type': types['.js'] } })
    }
    const f = Bun.file(file)
    if (!(await f.exists())) return new Response('not found', { status: 404, headers })
    const ext = file.slice(file.lastIndexOf('.'))
    const h = { ...headers, 'Content-Type': types[ext] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' }
    const range = req.headers.get('range')?.match(/bytes=(\d+)-(\d*)/)
    if (range) {
      const start = Number(range[1])
      const end = range[2] ? Number(range[2]) + 1 : f.size
      return new Response(f.slice(start, end), {
        status: 206,
        headers: { ...h, 'Content-Range': `bytes ${start}-${end - 1}/${f.size}` },
      })
    }
    return new Response(f, { headers: h })
  },
})
console.log(`bench server on http://127.0.0.1:${port}/ (wasm: ${wasmPath})`)
