import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { appRouter } from '@/server/trpcRouter'
import type { Todo } from '@/schema/todo'
import { createStaticHandler } from '@/server/staticFiles'
import { createBrowserEditorHandler, browserEditorHeaders } from '@kev-browser-agent-kit/opencode-chat/server'
import { authorizeEditing } from '@/server/editing'

const isProduction = process.env.NODE_ENV === 'production'
const useBuild = isProduction || !!process.env.SERVE_BUILD
const todos = new Map<string, Todo>()
const editor = createBrowserEditorHandler({
  authorize: authorizeEditing,
  preparedDirectory: '.editor/prepared',
  runtimeDirectory: process.env.RUNTIME_DIR ?? '../workspace-api/dist/runtime',
  clientDirectory: useBuild ? 'build/client' : undefined,
  model: { baseURL: 'https://opencode.ai/zen/v1', headers: { authorization: 'Bearer public' } },
})

const withEditor = (next: (request: Request) => Promise<Response>) => async (request: Request) => {
  const response = await editor(request) ?? await next(request)
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
