// Static server for the runtime harness: cross-origin isolation headers, the
// runtime bundles from runtime/dist, the prepared output (image, manifest,
// program scripts) and the kernel wasm.
//
//   bun runtime/harness/server.ts [port=4102]
//
// URL space:
//   /                      the harness page
//   /runtime/<file>        runtime/dist/<file>            Cache-Control: no-cache (revalidated, ETag)
//   /runtime/v/<tag>/<file>  same bytes, immutable for a year (code-cache experiments)
//   /prepared/<file>       prepared output directory, content-addressed names → immutable
//   /prepared-v/<tag>/<file>  same bytes, immutable, fresh URL per tag
//   /prepared-revalidate/<tag>/<file>  same bytes, no-cache (ETag revalidation)
//   /prepared-nocache/<file>  same bytes, no-store
//   /sw-cache/<tag>/<file>    answered by harness/sw.js from Cache Storage (page query sw=1)
//   /kernel.wasm           the kernel build (target-runtime if present, else target-kernel)
import { existsSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'

const here = import.meta.dir
const root = normalize(join(here, '../..'))
const port = Number(process.argv[2] ?? process.env.PORT ?? 4102)
const dist = join(here, '../dist')
// The node-runtime agent's own prepare output (built with its bat-modules fix) wins over the prepare agent's.
const prepared = process.env.BAT_PREPARED ?? [join(root, 'target-runtime/prepared/todo'), join(root, 'target-prepare/out/todo-new')].find((d) => existsSync(join(d, 'manifest.json')))!
const kernelWasm = () => {
  if (process.env.BAT_KERNEL_WASM) return process.env.BAT_KERNEL_WASM
  const candidates = ['target-runtime', 'target-kernel'].map((t) => join(root, t, 'wasm32-wasip1-threads/release/bat_kernel.wasm')).filter(existsSync)
  return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
}
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.batimg': 'application/octet-stream',
}
const IMMUTABLE = 'public, max-age=31536000, immutable'

async function file(req: Request, path: string, cache: string): Promise<Response> {
  const f = Bun.file(path)
  if (!(await f.exists())) return new Response('not found', { status: 404, headers: isolation })
  const ext = path.slice(path.lastIndexOf('.'))
  const etag = `"${f.size.toString(36)}-${Math.round(f.lastModified).toString(36)}"`
  const headers: Record<string, string> = { ...isolation, 'Content-Type': types[ext] ?? 'application/octet-stream', 'Cache-Control': cache, ETag: etag, 'Accept-Ranges': 'bytes' }
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
  const range = req.headers.get('range')?.match(/bytes=(\d+)-(\d*)/)
  if (range) {
    const startAt = Number(range[1])
    const end = range[2] ? Number(range[2]) + 1 : f.size
    return new Response(f.slice(startAt, end), { status: 206, headers: { ...headers, 'Content-Range': `bytes ${startAt}-${end - 1}/${f.size}` } })
  }
  return new Response(f, { headers })
}

Bun.serve({
  port,
  hostname: '0.0.0.0',
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url)
    const path = decodeURIComponent(url.pathname)
    if (path.includes('..')) return new Response('forbidden', { status: 403, headers: isolation })
    if (path === '/' || path === '/index.html') return file(req, join(here, 'index.html'), 'no-store')
    if (path === '/beat') {
      // Liveness of the page's main thread, for diagnosing hangs: `?debug=beat` on the page.
      await Bun.write(Bun.file('/tmp/bat-harness-beat.log'), `${Date.now()} ${url.search}\n`)
      return new Response('', { headers: isolation })
    }
    if (path === '/sw.js') {
      const r = await file(req, join(here, 'sw.js'), 'no-store')
      r.headers.set('Service-Worker-Allowed', '/')
      return r
    }
    if (path === '/kernel.wasm') return file(req, kernelWasm(), 'no-cache')
    let m = /^\/runtime\/v\/[^/]+\/(.+)$/.exec(path)
    if (m) return file(req, join(dist, m[1]), IMMUTABLE)
    m = /^\/runtime\/(.+)$/.exec(path)
    if (m) return file(req, join(dist, m[1]), 'no-cache')
    m = /^\/prepared\/(.+)$/.exec(path)
    if (m) return file(req, join(prepared, m[1]), m[1] === 'manifest.json' ? 'no-cache' : IMMUTABLE)
    // Same bytes under a fresh URL: a cache experiment starts from nothing by picking a new tag.
    m = /^\/prepared-v\/[^/]+\/(.+)$/.exec(path)
    if (m) return file(req, join(prepared, m[1]), IMMUTABLE)
    m = /^\/prepared-revalidate\/[^/]+\/(.+)$/.exec(path)
    if (m) return file(req, join(prepared, m[1]), 'no-cache')
    m = /^\/prepared-nocache\/(.+)$/.exec(path)
    if (m) return file(req, join(prepared, m[1]), 'no-store')
    return new Response('not found', { status: 404, headers: isolation })
  },
})
console.log(`runtime harness on http://127.0.0.1:${port}/  (prepared: ${prepared}; kernel: ${kernelWasm()})`)
