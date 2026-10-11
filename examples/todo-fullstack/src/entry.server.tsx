import type { EntryContext } from 'react-router'
import { ServerRouter } from 'react-router'
import { renderToReadableStream } from 'react-dom/server'

// Used by the build-time prerenderer, never by the production Bun server.
export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  entryContext: EntryContext,
): Promise<Response> {
  const body = await renderToReadableStream(<ServerRouter context={entryContext} url={request.url} />, {
    onError(error: unknown) {
      console.error(error)
      responseStatusCode = 500
    },
  })
  await body.allReady
  responseHeaders.set('Content-Type', 'text/html')
  return new Response(body, { status: responseStatusCode, headers: responseHeaders })
}
