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
  const [resetNote, setResetNote] = useState('')
  // Start over from the prepared source: this browser's edits and chat sessions are deleted.
  const reset = () => {
    setResetNote('Resetting…')
    void import('./editor-panel').then(panel => panel.resetWorkspace())
      .then(() => setResetNote('Workspace reset.'), error => setResetNote(error instanceof Error ? error.message : String(error)))
  }
  if (!policy?.allowed) return null
  return <>
    <aside style={{ padding: '1rem' }}>
      <small>Local admin fixture · source edits stay in this browser</small>{' '}
      <button onClick={() => { setResetNote(''); setIsEditing(true) }} disabled={isEditing}>Open editor</button>{' '}
      {!policy.fakeHost && <button onClick={reset} disabled={isEditing} title="Delete this browser's source edits and chat sessions">Reset workspace</button>}
      {resetNote && <small role="status"> {resetNote}</small>}
    </aside>
    {isEditing && <Suspense fallback={<p style={{ padding: '1rem' }}>Loading editor…</p>}>
      <EditorPanel fakeHost={policy.fakeHost} onExit={() => { setIsEditing(false); void queryClient.invalidateQueries() }} />
    </Suspense>}
  </>
}
