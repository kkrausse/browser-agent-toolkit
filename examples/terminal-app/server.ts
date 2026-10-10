// The page's server: static files, the toolkit's editor handler (prepared image, runtime,
// model proxy), the TODO app's API for the preview, and a scripted model for trying it
// without a key. Every response is cross-origin isolated.
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { createEditorHandler, readModelCatalog, type ModelCatalog } from '@kkrausse/browser-agent-toolkit/server'
import { existsSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { appRouter } from '../todo-app/src/server/trpcRouter'
import { authorizeEditing } from '../todo-app/src/server/editing'
import type { Todo } from '../todo-app/src/schema/todo'
import { scriptedModel, scriptedCatalog } from './scripted-model'

const here = import.meta.dirname
const port = Number(process.env.PORT) || 4310
const todos = new Map<string, Todo>()
if (!existsSync(resolve(here, '.wasm-term/embed.js'))) throw Error('No terminal: run `bun run wasm-term` in examples/terminal-app first (it needs a wasm-term checkout, see wasm-term.ts).')

// Which model answers, in order: a real key (gitignored .env.local, Bun loads it), another
// OpenAI-compatible server (MODEL_BASE_URL, e.g. wasm-term's mock-llm at
// http://127.0.0.1:4791/v1), else the scripted model below: no network, no tokens.
const modelKey = process.env.EDITOR_MODEL_API_KEY
const modelBase = process.env.MODEL_BASE_URL
const scriptedPath = '/scripted-model/v1'
const model: { name: string; baseURL: string; headers?: Record<string, string>; catalog: ModelCatalog } = modelKey
  ? { name: 'OpenCode Zen', baseURL: 'https://opencode.ai/zen/v1', headers: { authorization: `Bearer ${modelKey}`, 'user-agent': 'opencode/stable/2.0.3/vivari-opencode-server' }, catalog: await readModelCatalog(resolve(here, '../todo-app/model-catalog.json')) }
  : modelBase
    ? { name: modelBase, baseURL: modelBase, headers: { authorization: 'Bearer mock-key-not-real' }, catalog: scriptedCatalog('mock-model', 'Mock model') }
    : { name: 'scripted model (no tokens)', baseURL: `http://127.0.0.1:${port}${scriptedPath}`, catalog: scriptedCatalog('scripted', 'Scripted model') }

const editor = createEditorHandler({
  preparedDir: resolve(here, '.editor/prepared'),
  modelCatalog: model.catalog,
  providers: { opencode: { baseURL: model.baseURL, headers: model.headers } },
  onEvent: event => { if (event.type !== 'model.request') console.log(`[model] ${event.type} ${'status' in event ? event.status : event.error} ${event.ms} ms`) },
})

const isolation = { ...editor.headers, 'Cross-Origin-Resource-Policy': 'same-origin' }
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.map': 'application/json', '.wasm': 'application/wasm', '.scm': 'text/plain; charset=utf-8', '.json': 'application/json' }
const isolated = (response: Response) => {
  for (const [name, value] of Object.entries(isolation)) response.headers.set(name, value)
  return response
}
async function file(root: string, relative: string): Promise<Response> {
  const base = resolve(here, root), path = resolve(base, relative)
  const source = Bun.file(path)
  if (!path.startsWith(base + sep) || !await source.exists()) return new Response('Not found', { status: 404 })
  return new Response(source, { headers: { 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' } })
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  idleTimeout: 240,
  async fetch(request, server) {
    const path = new URL(request.url).pathname
    if (await editor.matches(request)) {
      if (!authorizeEditing(request)) return new Response('Editing is not authorized', { status: 403 })
      // A model's event stream may pause for longer than any idle limit.
      if (path.startsWith('/editor/model/')) server.timeout(request, 0)
      return editor.fetch(request)
    }
    if (path.startsWith(scriptedPath + '/')) return scriptedModel(request, path.slice(scriptedPath.length))
    if (path.startsWith('/api/')) return isolated(await fetchRequestHandler({ endpoint: '/api', req: request, router: appRouter, createContext: ({ req }) => ({ req, todos }) }))
    if (path === '/') return isolated(await file('.', 'index.html'))
    if (path.startsWith('/wasm-term/')) return isolated(await file('.wasm-term', decodeURIComponent(path.slice('/wasm-term/'.length))))
    return isolated(await file('.build', decodeURIComponent(path.slice(1))))
  },
})

console.log(`Terminal example at ${server.url}  (model: ${model.name})`)
