// A plain file server for `dist/`, for trying the build on this machine. It does nothing a
// static host would not: no headers of its own, no routes, no encodings. `bunx serve dist`
// or any file shelf does the same; the page's service worker (sw.ts) supplies the rest.
//
//   bun server.ts [directory]     PORT (default 4310); the page is `<directory>/index.html`
import { existsSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const root = resolve(process.argv[2] ?? resolve(import.meta.dirname, 'dist'))
if (!existsSync(root)) throw Error(`No ${root}: run \`bun run build\` in examples/terminal-app (or \`bun run terminal\` in the repository root).`)

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.PORT) || 4310,
  fetch(request) {
    let path: string
    try { path = resolve(root, '.' + decodeURIComponent(new URL(request.url).pathname)) } catch { return new Response('Bad path', { status: 400 }) }
    if (path !== root && !path.startsWith(root + sep)) return new Response('Not found', { status: 404 })
    if (existsSync(path) && statSync(path).isDirectory()) path = resolve(path, 'index.html')
    return existsSync(path) ? new Response(Bun.file(path)) : new Response('Not found', { status: 404 })
  },
})
console.log(`Terminal example at ${server.url} (static files of ${root})`)
