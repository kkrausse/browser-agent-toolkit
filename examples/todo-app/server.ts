import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { appRouter } from '@/server/trpcRouter'
import type { Todo } from '@/schema/todo'
import { createStaticHandler } from '@/server/staticFiles'
import { createEditorHandler, readModelCatalog } from '@kkrausse/browser-agent-toolkit/server'
import { authorizeEditing } from '@/server/editing'
import { resolve } from 'node:path'

const isProduction = process.env.NODE_ENV === 'production'
const useBuild = isProduction || !!process.env.SERVE_BUILD
const port = Number(process.env.PORT) || (useBuild ? 3000 : 3001)
const todos = new Map<string, Todo>()
// Bun loads the gitignored .env.local in this directory; the key never leaves the server.
const modelKey = process.env.VIVARI_MODEL_API_KEY
const needsKey = 'Chat needs a model key: put VIVARI_MODEL_API_KEY=<key> in examples/todo-app/.env.local and restart the server. The editor, files and preview work without it.'
// The checked-in catalog applies once a key exists; the provider refuses its models without one.
const modelCatalogPath = process.env.MODEL_CATALOG ?? (modelKey ? resolve(import.meta.dirname, 'model-catalog.json') : undefined)

const editor = createEditorHandler({
  preparedDir: '.editor/prepared',
  clientDir: useBuild ? 'build/client' : undefined,
  // Optional public catalog file ({models, defaultModel}); never a key. An
  // unreadable or invalid file stops the server here instead of at first use.
  modelCatalog: modelCatalogPath ? await readModelCatalog(modelCatalogPath) : undefined,
  providers: { opencode: { baseURL: 'https://opencode.ai/zen/v1', headers: {
    authorization: `Bearer ${modelKey || 'public'}`,
    // Chromium replaces the guest's User-Agent. Restore the real app identity (pinned 2.0.3).
    'user-agent': 'opencode/stable/2.0.3/vivari-opencode-server',
  } } },
  onEvent: event => { if (event.type !== 'model.request') console.log(`[editor] ${event.type} ${event.provider} ${'status' in event ? event.status : event.error} ${event.ms} ms`) },
})

// Development only (EDITOR_FAKE_HOST=1): the runtime's stand-in, native processes behind this server.
const fakeHost = process.env.EDITOR_FAKE_HOST === '1'
  ? await (await import('./fake-host')).createTodoFakeHost(`http://127.0.0.1:${port}`)
  : undefined

const forbidden = () => new Response('Editing is not authorized', { status: 403, headers: { 'Cache-Control': 'no-store' } })
const withHeaders = (response: Response) => {
  for (const [key, value] of Object.entries(editor.headers)) response.headers.set(key, value)
  return response
}
const app = createStaticHandler('build/client')
const api = (request: Request) => fetchRequestHandler({ endpoint: '/api', req: request, router: appRouter, createContext: ({ req }) => ({ req, todos }) })

const server = Bun.serve({
  hostname: '127.0.0.1',
  idleTimeout: 240,
  port,
  websocket: fakeHost?.websocket ?? { message() {} },
  async fetch(request, server) {
    const path = new URL(request.url).pathname
    if (fakeHost?.matches(request)) return authorizeEditing(request) ? fakeHost.fetch(request, server) : forbidden()
    // The app decides who may edit; the handler only routes and delivers.
    if (await editor.matches(request)) {
      if (!authorizeEditing(request)) return forbidden()
      // Answer inference plainly instead of forwarding a request the provider would refuse.
      if (!modelKey && request.method === 'POST' && path.startsWith('/editor/model/')) {
        return Response.json({ error: { type: 'authentication_error', message: needsKey } }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
      }
      return editor.fetch(request)
    }
    if (path === '/editing-policy') return Response.json({ allowed: authorizeEditing(request), fakeHost: !!fakeHost }, { headers: { 'Cache-Control': 'no-store' } })
    if (path.startsWith('/api/')) return withHeaders(await api(request))
    return useBuild ? withHeaders(await app(request)) : new Response('Not found', { status: 404 })
  },
})

console.log(`Server running at ${server.url}`)
if (!modelKey) console.log(needsKey)
if (fakeHost) console.log('Editor runtime: development fake host (native Vite and OpenCode). Not a sandbox.')
