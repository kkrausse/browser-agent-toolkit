import { lazy, Suspense, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

const EditorPanel = lazy(() => import('./editor-panel'))

/** App-owned UI gate. The server independently protects editor assets and model calls.
 * In the editor's own preview the toolkit's Vite plugin replaces this module with nothing. */
export default function Editing() {
  const queryClient = useQueryClient()
  const [policy, setPolicy] = useState<{ allowed: boolean; fakeHost: boolean }>()
  const [isEditing, setIsEditing] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    void fetch('/editing-policy', { signal: abort.signal }).then(response => response.json()).then(setPolicy).catch(() => {})
    return () => abort.abort()
  }, [])
  if (!policy?.allowed) return null
  return <>
    <aside style={{ padding: '1rem' }}>
      <small>Local admin fixture · source edits stay in this browser</small>{' '}
      <button onClick={() => setIsEditing(true)} disabled={isEditing}>Open editor</button>
    </aside>
    {isEditing && <Suspense fallback={<p style={{ padding: '1rem' }}>Loading editor…</p>}>
      <EditorPanel fakeHost={policy.fakeHost} onExit={() => { setIsEditing(false); void queryClient.invalidateQueries() }} />
    </Suspense>}
  </>
}
