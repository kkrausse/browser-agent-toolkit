import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@/lib/trpc'

export default function Home() {
  const [title, setTitle] = useState('')
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const todos = useQuery(trpc.getTodos.queryOptions())
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.getTodos.queryKey() })
  const add = useMutation(trpc.addTodo.mutationOptions({ onSuccess: async () => {
    setTitle('')
    await refresh()
  } }))
  const complete = useMutation(trpc.setTodoCompleted.mutationOptions({ onSuccess: refresh }))
  const remove = useMutation(trpc.deleteTodo.mutationOptions({ onSuccess: refresh }))
  const busy = todos.isPending || add.isPending || complete.isPending || remove.isPending
  const error = todos.error ?? add.error ?? complete.error ?? remove.error

  return (
    <main>
      <h1>Todos</h1>
      <p>Browser Agent Toolkit proof of concept: a TODO app with optional browser-hosted agent editing.</p>
      <form onSubmit={(event) => {
        event.preventDefault()
        add.reset(); complete.reset(); remove.reset()
        add.mutate({ title })
      }}>
        <label htmlFor="title">New todo</label>
        <div className="row">
          <input id="title" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} disabled={busy} />
          <button disabled={busy || !title.trim()}>Add</button>
        </div>
      </form>
      {error && <p role="alert">{error.message} <button onClick={() => {
        add.reset(); complete.reset(); remove.reset()
        void todos.refetch()
      }}>Retry</button></p>}
      {busy && <p role="status">Loading…</p>}
      {!busy && !error && !todos.data?.length && <p>No todos yet.</p>}
      <ul>
        {todos.data?.map((todo) => (
          <li key={todo.id}>
            <label>
              <input type="checkbox" checked={todo.completed} disabled={busy} onChange={() => complete.mutate({ id: todo.id, completed: !todo.completed })} />
              <span className={todo.completed ? 'line-through' : undefined}>{todo.title}</span>
            </label>
            <button disabled={busy} aria-label={`Delete ${todo.title}`} onClick={() => remove.mutate({ id: todo.id })}>Delete</button>
          </li>
        ))}
      </ul>
    </main>
  )
}
