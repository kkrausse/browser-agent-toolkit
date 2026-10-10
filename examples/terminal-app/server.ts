// The page's server: static files with cross-origin isolation, and the TODO app's own API
// (the app in the preview is a client of it). Nothing here knows about models: the OpenCode
// server in the tab fetches its model endpoint directly, cross-origin (`?model=`, see
// src/main.ts and mock-model.ts). The toolkit's server handler (model proxy, catalog,
// private chunks) is deliberately not used.
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { existsSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { appRouter } from '../todo-app/src/server/trpcRouter'
import type { Todo } from '../todo-app/src/schema/todo'

const here = import.meta.dirname
const port = Number(process.env.PORT) || 4310
const todos = new Map<string, Todo>()
for (const [path, how] of [['.wasm-term/embed.js', 'bun run wasm-term'], ['.editor/prepared/manifest.json', 'bun run prepare:editor'], ['.build/main.js', 'bun run build']] as const) {
  if (!existsSync(resolve(here, path))) throw Error(`Missing ${path}: run \`${how}\` in examples/terminal-app (or \`bun run terminal\` in the repository root).`)
}

const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // The runtime's service worker script sits under /editor/runtime/ and controls /preview/.
  'Service-Worker-Allowed': '/',
}
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.map': 'application/json', '.wasm': 'application/wasm', '.scm': 'text/plain; charset=utf-8', '.json': 'application/json' }
/** `/` → index.html, `/wasm-term/…` → the terminal's files, `/editor/…` → the prepared runtime, image and manifest, the rest → the built page. */
const roots: [prefix: string, directory: string][] = [['/wasm-term/', '.wasm-term'], ['/editor/', '.editor/prepared'], ['/', '.build']]

async function file(request: Request, pathname: string): Promise<Response> {
  if (pathname === '/') return new Response(Bun.file(resolve(here, 'index.html')), { headers: { ...isolation, 'Content-Type': types['.html']!, 'Cache-Control': 'no-cache' } })
  const [prefix, directory] = roots.find(([prefix]) => pathname.startsWith(prefix))!
  const base = resolve(here, directory), path = resolve(base, pathname.slice(prefix.length))
  const source = Bun.file(path)
  if (!path.startsWith(base + sep) || !await source.exists()) return new Response('Not found', { status: 404, headers: isolation })
  const headers: Record<string, string> = { ...isolation, 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }
  // prepare() writes zstd copies of the big files (the 240 MB dependency image is 32 MB that way);
  // the browser decodes them in its network stack.
  const compressed = Bun.file(path + '.zst')
  if (!request.headers.has('range') && /\bzstd\b/.test(request.headers.get('accept-encoding') ?? '') && await compressed.exists()) {
    return new Response(compressed, { headers: { ...headers, 'Content-Encoding': 'zstd', Vary: 'Accept-Encoding' } })
  }
  return new Response(source, { headers })
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  idleTimeout: 240,
  async fetch(request) {
    let pathname: string
    try { pathname = decodeURIComponent(new URL(request.url).pathname) } catch { return new Response('Bad path', { status: 400 }) }
    if (pathname.startsWith('/api/')) {
      const response = await fetchRequestHandler({ endpoint: '/api', req: request, router: appRouter, createContext: ({ req }) => ({ req, todos }) })
      for (const [name, value] of Object.entries(isolation)) response.headers.set(name, value)
      return response
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: isolation })
    return file(request, pathname)
  },
})

console.log(`Terminal example at ${server.url}`)
