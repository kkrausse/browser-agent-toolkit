import { resolve, sep } from 'node:path'

/** The built app (`vite build`): its files, and `index.html` for `/`. */
export function createStaticHandler(directory: string): (request: Request) => Promise<Response> {
  const root = resolve(directory)
  const notFound = () => new Response('Not found', { status: 404 })

  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
    }
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    if (pathname === '/') pathname = '/index.html'
    const path = resolve(root, `.${pathname}`)
    if (!path.startsWith(`${root}${sep}`) || pathname.includes('\0')) return notFound()
    const file = Bun.file(path)
    if (!(await file.exists()) || !(await file.stat()).isFile()) return notFound()
    return new Response(request.method === 'HEAD' ? null : file, {
      headers: {
        'Content-Type': file.type,
        'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      },
    })
  }
}
