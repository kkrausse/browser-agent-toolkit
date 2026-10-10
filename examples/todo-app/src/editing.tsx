import { useEffect, useState, type ComponentType } from 'react'
import { useQueryClient } from '@tanstack/react-query'

type Panel = ComponentType<{ fakeHost: boolean; onExit(): void }>

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
  // The editor chunk is fetched as soon as the button exists, not when it is clicked, and it
  // is rendered directly: a lazy component under Suspense is held back 300 ms by React's
  // fallback throttle, which was a fifth of the whole open.
  const [Panel, setPanel] = useState<Panel>()
  useEffect(() => {
    if (!policy?.allowed) return
    let current = true
    void import('./editor-panel').then(module => {
      if (!current) return
      setPanel(() => module.default)
      if (!policy.fakeHost) module.preloadEditor()
    })
    return () => { current = false }
  }, [policy])
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
    {isEditing && (Panel
      ? <Panel fakeHost={policy.fakeHost} onExit={() => { setIsEditing(false); void queryClient.invalidateQueries() }} />
      : <p style={{ padding: '1rem' }}>Loading editor…</p>)}
  </>
}
