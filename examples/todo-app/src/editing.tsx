import { lazy, Suspense, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

const EditorPanel = lazy(() => import('./editor-panel'))

/** App-owned UI gate. The server independently protects editor assets and model calls. */
export default function Editing() {
  const queryClient = useQueryClient()
  const [allowed, setAllowed] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    void fetch('/editing-policy', { signal: abort.signal }).then(response => response.json())
      .then(policy => setAllowed(policy.allowed === true)).catch(() => {})
    return () => abort.abort()
  }, [])
  if (!allowed) return null
  return <>
    <aside style={{ padding: '1rem' }}>
      <small>Local admin fixture · browser-local source saves</small>{' '}
      <button onClick={() => setIsEditing(true)} disabled={isEditing}>Open editor</button>
    </aside>
    {isEditing && <Suspense fallback={<p>Loading editor…</p>}>
      <EditorPanel onExit={() => { setIsEditing(false); void queryClient.invalidateQueries() }} />
    </Suspense>}
  </>
}
