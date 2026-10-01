import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { appRouter } from '@/server/trpcRouter'
import type { Todo } from '@/schema/todo'
import { createStaticHandler } from '@/server/staticFiles'
import { createBrowserEditorHandler, browserEditorHeaders, readModelCatalog } from '@kev-browser-agent-kit/opencode-chat/server'
import { authorizeEditing } from '@/server/editing'
import { resolve } from 'node:path'

const isProduction = process.env.NODE_ENV === 'production'
const useBuild = isProduction || !!process.env.SERVE_BUILD
const todos = new Map<string, Todo>()
// Bun loads the gitignored .env.local in this directory; the key never leaves the server.
const modelKey = process.env.VIVARI_MODEL_API_KEY
const needsKey = 'Chat needs a model key: put VIVARI_MODEL_API_KEY=<key> in examples/todo-app/.env.local and restart the server. The editor, files and preview work without it.'
// The checked-in catalog applies once a key exists; the provider refuses its models without one.
const modelCatalogPath = process.env.MODEL_CATALOG ?? (modelKey ? resolve(import.meta.dirname, 'model-catalog.json') : undefined)
const editor = createBrowserEditorHandler({
  preparedDirectory: '.editor/prepared',
  runtimeDirectory: process.env.RUNTIME_DIR ?? '../../workspace-api/dist/runtime',
  clientDirectory: useBuild ? 'build/client' : undefined,
  // Optional public catalog file ({models, defaultModel}); never a key. An
  // unreadable or invalid file stops the server here instead of at first use.
  modelCatalog: modelCatalogPath ? await readModelCatalog(modelCatalogPath) : undefined,
  providers: { opencode: { baseURL: 'https://opencode.ai/zen/v1', headers: {
    authorization: `Bearer ${modelKey || 'public'}`,
    // Chromium replaces the guest's User-Agent. Restore the real app identity
    // from vivari/experiments/opencode-release-server/server.ts (pinned 2.0.3).
    'user-agent': 'opencode/stable/2.0.3/vivari-opencode-server',
  } } },
})

const withEditor = (next: (request: Request) => Promise<Response>) => async (request: Request) => {
  if (await editor.matches(request)) {
    if (!authorizeEditing(request)) return new Response('Editing is not authorized', { status: 403, headers: { 'Cache-Control': 'no-store' } })
    // Answer inference plainly instead of forwarding a request the provider would refuse.
    if (!modelKey && request.method === 'POST' && new URL(request.url).pathname.startsWith('/editor/model/')) {
      return Response.json({ error: { type: 'authentication_error', message: needsKey } }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
    }
    return await editor.fetch(request) ?? new Response('Not found', { status: 404 })
  }
  const response = await next(request)
  for (const [key, value] of Object.entries(browserEditorHeaders)) response.headers.set(key, value)
  return response
}

const apiRoutes = {
  '/editing-policy': (req: Request) => Response.json({ allowed: authorizeEditing(req), fixture: 'local admin' }, { headers: { 'Cache-Control': 'no-store' } }),
  '/editor/*': withEditor(async () => new Response('Not found', { status: 404 })),
  '/api/*': (req: Request) => fetchRequestHandler({
    endpoint: '/api',
    req,
    router: appRouter,
    createContext: ({ req }) => ({ req, todos }),
  }),
}
const buildRoutes: Record<string, (req: Request) => Promise<Response>> = useBuild
  ? { '/*': withEditor(createStaticHandler('build/client')) }
  : {}

const server = Bun.serve({
  hostname: '127.0.0.1',
  idleTimeout: 240,
  port: useBuild ? Number(process.env.PORT) || 3000 : 3001,
  routes: { ...apiRoutes, ...buildRoutes },
})

console.log(`Server running at ${server.url}`)
if (!modelKey) console.log(needsKey)
