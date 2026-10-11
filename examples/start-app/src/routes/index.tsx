import { createFileRoute, useRouter } from '@tanstack/react-router'
import type { Effect } from 'effect'
import { useState } from 'react'
import { api, type TodoClient } from '../api/client'
import type { Todo } from '../api/contract'

export const Route = createFileRoute('/')({
  // Runs on the server for the first page and in the browser after that; the same call either way.
  loader: async () => {
    const todos = await api(client => client.ListTodos())
    if (todos._tag === 'Failure') throw new Error(`Could not load the todos: ${todos.failure.message}`)
    return todos.success
  },
  component: Home,
})

function Home() {
  const todos = Route.useLoaderData()
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [problem, setProblem] = useState<string>()

  // One mutation: call the API, say what went wrong if anything did, and load the list again.
  const change = async (todo: Todo | undefined, call: (client: TodoClient) => Effect.Effect<unknown, Problem>) => {
    const result = await api(call)
    setProblem(result._tag === 'Failure' ? describe(result.failure, todo) : undefined)
    await router.invalidate()
    return result._tag === 'Success'
  }

  return (
    <main>
      <h1>Todos</h1>
      <p>Browser Agent Toolkit proof of concept: a full-stack TODO app (TanStack Start, an Effect API, SQLite) running in the browser tab.</p>
      <form onSubmit={async (event) => {
        event.preventDefault()
        if (await change(undefined, client => client.AddTodo({ title }))) setTitle('')
      }}>
        <label htmlFor="title">New todo</label>
        <div className="row">
          <input id="title" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} />
          <button disabled={!title.trim()}>Add</button>
        </div>
      </form>
      {problem && <p role="alert" className="problem">{problem}</p>}
      {!todos.length && <p>No todos yet.</p>}
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            <label>
              <input type="checkbox" checked={todo.completed} onChange={() => change(todo, client => client.ToggleTodo({ id: todo.id }))} />
              <span className={todo.completed ? 'line-through' : undefined}>{todo.title}</span>
            </label>
            <button aria-label={`Delete ${todo.title}`} onClick={() => change(todo, client => client.DeleteTodo({ id: todo.id }))}>Delete</button>
          </li>
        ))}
      </ul>
    </main>
  )
}

// Every error a mutation can end with, taken from the contract.
type Problem = Effect.Error<ReturnType<TodoClient['AddTodo' | 'ToggleTodo' | 'DeleteTodo']>>

function describe(error: Problem, todo: Todo | undefined): string {
  switch (error._tag) {
    case 'TodoNotFound': return `"${todo?.title ?? error.id}" no longer exists: it was deleted somewhere else.`
    case 'RpcClientError': return `The server could not be reached (${error.message}).`
  }
}
