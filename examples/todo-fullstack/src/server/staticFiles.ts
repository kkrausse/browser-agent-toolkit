import { resolve, sep } from 'node:path'

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
    const path = resolve(root, `.${pathname}`)
    if ((path !== root && !path.startsWith(`${root}${sep}`)) || pathname.includes('\0')) return notFound()

    const respond = async (filePath: string): Promise<Response | undefined> => {
      const file = Bun.file(filePath)
      if (!(await file.exists()) || !(await file.stat()).isFile()) return undefined
      return new Response(request.method === 'HEAD' ? null : file, {
        headers: {
          'Content-Type': file.type,
          'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        },
      })
    }

    const exact = await respond(path)
    if (exact) return exact
    if (
      pathname.startsWith('/assets/') ||
      pathname.startsWith('/.well-known/') ||
      pathname.split('/').at(-1)?.includes('.')
    ) {
      return notFound()
    }
    const page = await respond(resolve(path, 'index.html'))
    if (page) return page

    // Only application routes receive HTML fallbacks; this app has only the index route.
    if (pathname === '/') {
      return (await respond(resolve(root, '__spa-fallback.html'))) ?? notFound()
    }
    return notFound()
  }
}
