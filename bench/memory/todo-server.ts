#!/usr/bin/env bun
// The TODO example's server (examples/todo-app/server.ts) with one difference: the model
// provider's requests are forwarded to the scripted model of the terminal example
// (examples/terminal-app/mock-model.ts) instead of a paid endpoint. Measurement only; the
// example itself is not changed. Run from examples/todo-app (serve.sh does):
//
//   PORT=4871 MOCK_URL=http://127.0.0.1:4872/v1 bun ../../bench/memory/todo-server.ts
import { resolve } from 'node:path'
import { appRouter } from '../../examples/todo-app/src/server/trpcRouter'
import type { Todo } from '../../examples/todo-app/src/schema/todo'
import { createStaticHandler } from '../../examples/todo-app/src/server/staticFiles'
import { authorizeEditing } from '../../examples/todo-app/src/server/editing'

const app = resolve(import.meta.dirname, '../../examples/todo-app')
process.chdir(app)
// The packages are the example's dependencies, not this directory's: resolve them from there.
const { fetchRequestHandler } = await import(Bun.resolveSync('@trpc/server/adapters/fetch', app)) as typeof import('@trpc/server/adapters/fetch')
const { createEditorHandler, readModelCatalog } = await import(Bun.resolveSync('@kkrausse/browser-agent-toolkit/server', app)) as typeof import('@kkrausse/browser-agent-toolkit/server')
const port = Number(process.env.PORT) || 4871
const todos = new Map<string, Todo>()
const editor = createEditorHandler({
  // PREPARED_DIR: another prepared directory (an experiment's copy).
  preparedDir: process.env.PREPARED_DIR ?? '.editor/prepared',
  clientDir: 'build/client',
  modelCatalog: await readModelCatalog(resolve(app, 'model-catalog.json')),
  providers: { opencode: { baseURL: process.env.MOCK_URL ?? 'http://127.0.0.1:4872/v1', headers: { authorization: 'Bearer scripted' } } },
  onEvent: event => { if (event.type !== 'model.request') console.log(`[editor] ${event.type} ${'status' in event ? event.status : event.error} ${event.ms} ms`) },
})
const forbidden = () => new Response('Editing is not authorized', { status: 403, headers: { 'Cache-Control': 'no-store' } })
const withHeaders = (response: Response) => {
  for (const [key, value] of Object.entries(editor.headers)) response.headers.set(key, value)
  return response
}
const files = createStaticHandler('build/client')
const api = (request: Request) => fetchRequestHandler({ endpoint: '/api', req: request, router: appRouter, createContext: ({ req }: { req: Request }) => ({ req, todos }) })

const server = Bun.serve({
  hostname: '127.0.0.1',
  idleTimeout: 240,
  port,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (await editor.matches(request)) return authorizeEditing(request) ? editor.fetch(request) : forbidden()
    if (path === '/editing-policy') return Response.json({ allowed: authorizeEditing(request), fakeHost: false }, { headers: { 'Cache-Control': 'no-store' } })
    if (path.startsWith('/api/')) return withHeaders(await api(request))
    return withHeaders(await files(request))
  },
})
console.log(`Memory bench TODO server at ${server.url}, model → ${process.env.MOCK_URL ?? 'http://127.0.0.1:4872/v1'}`)
