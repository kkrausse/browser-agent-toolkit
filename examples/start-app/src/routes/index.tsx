import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

export const Route = createFileRoute('/')({
  loader: () => ({ renderedAt: typeof window === 'undefined' ? 'server' : 'client' }),
  component: Home,
})

function Home() {
  const { renderedAt } = Route.useLoaderData()
  const [count, setCount] = useState(0)
  return (
    <main>
      <h1>Todos</h1>
      <p>Loader ran on the {renderedAt}.</p>
      <button onClick={() => setCount(count + 1)}>Clicked {count}</button>
    </main>
  )
}
