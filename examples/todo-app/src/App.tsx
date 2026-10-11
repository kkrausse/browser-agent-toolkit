import { useEffect, useState } from 'react'

interface Todo { id: string; title: string; completed: boolean }

// The list is kept in this browser. The editor's preview is a frame on the same origin, so
// it reads and writes the same list as the page around it.
const storageKey = 'todos'
function load(): Todo[] {
  try { return JSON.parse(localStorage.getItem(storageKey) ?? '[]') } catch { return [] }
}

export default function App() {
  const [todos, setTodos] = useState(load)
  const [title, setTitle] = useState('')
  // Another document of this origin (the preview, or the page around it) changed the list.
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === storageKey || event.key === null) setTodos(load()) }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [])
  const save = (next: Todo[]) => {
    setTodos(next)
    localStorage.setItem(storageKey, JSON.stringify(next))
  }

  return (
    <main>
      <h1>Todos</h1>
      <p>Browser Agent Toolkit proof of concept: a TODO app with optional browser-hosted agent editing.</p>
      <form onSubmit={(event) => {
        event.preventDefault()
        if (!title.trim()) return
        save([...todos, { id: crypto.randomUUID(), title: title.trim(), completed: false }])
        setTitle('')
      }}>
        <label htmlFor="title">New todo</label>
        <div className="row">
          <input id="title" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} />
          <button disabled={!title.trim()}>Add</button>
        </div>
      </form>
      {!todos.length && <p>No todos yet.</p>}
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            <label>
              <input type="checkbox" checked={todo.completed} onChange={() => save(todos.map((other) => other.id === todo.id ? { ...other, completed: !other.completed } : other))} />
              <span className={todo.completed ? 'line-through' : undefined}>{todo.title}</span>
            </label>
            <button aria-label={`Delete ${todo.title}`} onClick={() => save(todos.filter((other) => other.id !== todo.id))}>Delete</button>
          </li>
        ))}
      </ul>
    </main>
  )
}
