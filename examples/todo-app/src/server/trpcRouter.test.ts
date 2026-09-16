import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import type { Todo } from '@/schema/todo'
import { appRouter, type AppRouter } from '@/server/trpcRouter'

describe('todo tRPC HTTP protocol', () => {
  let server: ReturnType<typeof Bun.serve>
  let client: ReturnType<typeof createTRPCClient<AppRouter>>
  beforeEach(() => {
    const todos = new Map<string, Todo>()
    server = Bun.serve({
      port: 0,
      routes: { '/api/*': (req) => fetchRequestHandler({
        endpoint: '/api', req, router: appRouter, createContext: ({ req }) => ({ req, todos }),
      }) },
    })
    client = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: `${server.url}api` })] })
  })
  afterEach(() => server.stop(true))

  test('CRUD through the typed batch client', async () => {
    expect(await client.getTodos.query()).toEqual([])
    const todo = await client.addTodo.mutate({ title: ' Buy milk ' })
    expect(todo).toEqual({ id: expect.any(String), title: 'Buy milk', completed: false })
    expect(await client.getTodos.query()).toEqual([todo])
    expect(await client.setTodoCompleted.mutate({ id: todo.id, completed: true })).toEqual({ ...todo, completed: true })
    expect(await client.getTodos.query()).toEqual([{ ...todo, completed: true }])
    await client.setTodoCompleted.mutate({ id: todo.id, completed: false })
    expect(await client.deleteTodo.mutate({ id: todo.id })).toEqual({ id: todo.id })
    expect(await client.getTodos.query()).toEqual([])
    await expect(client.deleteTodo.mutate({ id: todo.id })).rejects.toMatchObject({ data: { code: 'NOT_FOUND', httpStatus: 404 } })
  })

  test('validation and missing IDs return structured tRPC errors without changing data', async () => {
    for (const title of ['', '  ', 'x'.repeat(201)]) {
      await expect(client.addTodo.mutate({ title })).rejects.toMatchObject({ data: { code: 'BAD_REQUEST', httpStatus: 400 } })
    }
    const todo = await client.addTodo.mutate({ title: 'Keep' })
    const response = await fetch(`${server.url}api/setTodoCompleted`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: todo.id, completed: 'yes' }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { data: { code: 'BAD_REQUEST' } } })
    await expect(client.setTodoCompleted.mutate({ id: 'missing', completed: true })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
    expect(await client.getTodos.query()).toEqual([todo])
  })

  test('malformed JSON, unknown procedures, wrong methods, and mixed batches use tRPC protocol', async () => {
    const malformed = await fetch(`${server.url}api/addTodo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({ error: { message: 'Failed to parse JSON', data: { code: 'BAD_REQUEST' } } })
    const missing = await fetch(`${server.url}api/missing`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { data: { code: 'NOT_FOUND' } } })
    const wrongMethod = await fetch(`${server.url}api/addTodo`)
    expect(wrongMethod.status).toBe(405)
    expect(await wrongMethod.json()).toMatchObject({ error: { data: { code: 'METHOD_NOT_SUPPORTED' } } })
    const batch = await fetch(`${server.url}api/getTodos,missing?batch=1`)
    expect(batch.status).toBe(207)
    expect(await batch.json()).toMatchObject([{ result: { data: [] } }, { error: { data: { code: 'NOT_FOUND' } } }])
  })
})
