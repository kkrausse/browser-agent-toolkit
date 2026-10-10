// Static server for the node:sqlite browser check (real kernel, real OPFS).
// Cross-origin isolation headers, .ts bundled on request, the kernel and
// SQLite Wasm files.   bun runtime/src/sqlite/harness/browser/server.ts [port]
import { join, normalize } from 'node:path'

const root = normalize(join(import.meta.dir, '../../../../..'))
const port = Number(process.argv[2] ?? process.env.PORT ?? 4105)
const kernelWasm = process.env.BAT_KERNEL_WASM ?? join(root, 'target-kernel/wasm32-wasip1-threads/release/bat_kernel.wasm')
const sqliteWasm = process.env.BAT_SQLITE_WASM ?? join(root, 'runtime/src/sqlite/sqlite3.wasm')
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
}
const bundles = new Map<string, string>()

Bun.serve({
  port,
  hostname: '127.0.0.1',
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url)
    let path = decodeURIComponent(url.pathname)
    if (path === '/') path = '/runtime/src/sqlite/harness/browser/index.html'
    if (path === '/kernel.wasm') return new Response(Bun.file(kernelWasm), { headers: { ...headers, 'Content-Type': 'application/wasm' } })
    if (path === '/sqlite3.wasm') return new Response(Bun.file(sqliteWasm), { headers: { ...headers, 'Content-Type': 'application/wasm' } })
    const file = normalize(join(root, path))
    if (!file.startsWith(root)) return new Response('forbidden', { status: 403, headers })
    if (file.endsWith('.ts')) {
      // Bundled once per server start: restart the server after editing sources.
      let text = bundles.get(file)
      if (text === undefined) {
        const out = await Bun.build({ entrypoints: [file], target: 'browser', format: 'esm' })
        if (!out.success) return new Response(out.logs.map(String).join('\n'), { status: 500, headers })
        text = await out.outputs[0].text()
        bundles.set(file, text)
      }
      return new Response(text, { headers: { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' } })
    }
    const f = Bun.file(file)
    if (!(await f.exists())) return new Response('not found', { status: 404, headers })
    return new Response(f, { headers: { ...headers, 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' } })
  },
})
console.log(`sqlite browser check on http://127.0.0.1:${port}/ (kernel: ${kernelWasm})`)
