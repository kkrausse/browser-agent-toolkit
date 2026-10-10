// The TODO app's own backend (`/api`, the tRPC router of ../todo-app), as a program for the
// guest: the build bundles it into one file, the page writes that into the tab's filesystem
// and starts it with `node` beside the dev server. The app in the frame calls `/api/…` as
// it does on a real server; the service worker hands those requests to this listener.
// The list is kept in a file in the workspace, so it is still there after a reload.
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import { appRouter } from '../todo-app/src/server/trpcRouter'
import type { Todo } from '../todo-app/src/schema/todo'

const port = Number(process.env.PORT) || 3001
const store = process.env.TODO_STORE
const todos = new Map<string, Todo>()
if (store) {
  try { for (const todo of JSON.parse(readFileSync(store, 'utf8')) as Todo[]) todos.set(todo.id, todo) } catch { /* none yet */ }
}

createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(chunk as Buffer)
    const headers = new Headers()
    for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(name, value)
    const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, { method: incoming.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined })
    const response = await fetchRequestHandler({ endpoint: '/api', req: request, router: appRouter, createContext: ({ req }) => ({ req, todos }) })
    if (store && incoming.method !== 'GET') {
      mkdirSync(dirname(store), { recursive: true })
      writeFileSync(store, JSON.stringify([...todos.values()]))
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers))
    outgoing.end(Buffer.from(await response.arrayBuffer()))
  } catch (error) {
    console.error(error)
    outgoing.writeHead(500, { 'content-type': 'text/plain' }).end(String(error))
  }
}).listen(port, '127.0.0.1', () => console.log(`todo api on 127.0.0.1:${port}${store ? `, list in ${store}` : ''}`))
