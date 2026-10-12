import { createEditorHandler, readModelCatalog } from '@kkrausse/browser-agent-toolkit/server'
import { resolve } from 'node:path'
import { createStaticHandler } from './static-files'

const isProduction = process.env.NODE_ENV === 'production'
const useBuild = isProduction || !!process.env.SERVE_BUILD
const port = Number(process.env.PORT) || (useBuild ? 3000 : 3001)
// Bun loads the gitignored .env.local in this directory; the key never leaves the server.
const modelKey = process.env.EDITOR_MODEL_API_KEY
const needsKey = 'Chat needs a model key: put EDITOR_MODEL_API_KEY=<key> in examples/todo-app/.env.local and restart the server. The editor, files and preview work without it.'
// The checked-in catalog applies once a key exists; the provider refuses its models without one.
const modelCatalogPath = process.env.MODEL_CATALOG ?? (modelKey ? resolve(import.meta.dirname, 'model-catalog.json') : undefined)

const editor = createEditorHandler({
  preparedDir: '.editor/prepared',
  clientDir: useBuild ? 'dist' : undefined,
  // Optional public catalog file ({models, defaultModel}); never a key. An
  // unreadable or invalid file stops the server here instead of at first use.
  modelCatalog: modelCatalogPath ? await readModelCatalog(modelCatalogPath) : undefined,
  // EDITOR_MODEL_BASE_URL: another OpenAI Responses endpoint in place of OpenCode Zen, e.g. the scripted
  // mock of examples/terminal-app (`PORT=4311 bun mock-model.ts` → http://127.0.0.1:4311/v1, any key).
  providers: { opencode: { baseURL: process.env.EDITOR_MODEL_BASE_URL || 'https://opencode.ai/zen/v1', headers: {
    authorization: `Bearer ${modelKey || 'public'}`,
    // Chromium replaces the guest's User-Agent. Restore the server's own identity (ports/opencode/server, 2.0.26).
    'user-agent': 'opencode/stable/2.0.26/bat-opencode-server',
  } } },
  onEvent: event => { if (event.type !== 'model.request') console.log(`[editor] ${event.type} ${event.provider} ${'status' in event ? event.status : event.error} ${event.ms} ms`) },
})

// Development only (EDITOR_FAKE_HOST=1): the runtime's stand-in, native processes behind this server.
const fakeHost = process.env.EDITOR_FAKE_HOST === '1'
  ? await (await import('./fake-host')).createTodoFakeHost(`http://127.0.0.1:${port}`)
  : undefined

/** The todo app is an editor demo: editing is always on. The server listens on loopback
 * only (reach it remotely through e.g. `tailscale serve`); refuse cross-site requests. */
function authorizeEditing(request: Request) {
  const origin = request.headers.get('origin')
  // A TLS-terminating proxy changes scheme and port, so compare hostnames.
  return !origin || new URL(origin).hostname === new URL(request.url).hostname
}

const forbidden = () => new Response('Editing is not authorized', { status: 403, headers: { 'Cache-Control': 'no-store' } })
const withHeaders = (response: Response) => {
  for (const [key, value] of Object.entries(editor.headers)) response.headers.set(key, value)
  return response
}
const app = createStaticHandler('dist')

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
    return useBuild ? withHeaders(await app(request)) : new Response('Not found', { status: 404 })
  },
})

console.log(`Server running at ${server.url}`)
if (!modelKey) console.log(needsKey)
if (fakeHost) console.log('Editor runtime: development fake host (native Vite and OpenCode). Not a sandbox.')
