import { useEffect } from 'react'
import { WorkspaceProvider, useWorkspace } from '@kev-browser-agent-kit/workspace/react'
import { createBrowserEditorDiagnostics } from '@kev-browser-agent-kit/opencode-chat/diagnostics'
import { WorkspaceEditor } from './workspace-editor'
import { editorTimings } from './editor-timings'
import './editor-panel.css'

// Always feeds the in-page Timings view. Events leave the browser only when the host
// enabled capture (`bun run editor:debug`), and then only to this app's own server.
const diagnostics = createBrowserEditorDiagnostics({ onDiagnostic: editorTimings.onDiagnostic })

export default function EditorPanel({ onExit }: { onExit(warning?: string): void }) {
  useEffect(() => {
    const detach = diagnostics.attach(window)
    void diagnostics.connect()
    return detach
  }, [])
  return <WorkspaceProvider onDiagnostic={diagnostics.onDiagnostic} captureProcessOutput={() => diagnostics.enabled}><Panel onExit={onExit} /></WorkspaceProvider>
}
function Panel({ onExit }: { onExit(warning?: string): void }) {
  const { controller } = useWorkspace()
  return <WorkspaceEditor controller={controller} onExit={onExit} />
}
