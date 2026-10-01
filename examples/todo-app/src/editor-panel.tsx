import { WorkspaceProvider, useWorkspace } from '@kev-browser-agent-kit/workspace/react'
import { WorkspaceEditor } from './workspace-editor'
import { editorTimings } from './editor-timings'
import './editor-panel.css'

export default function EditorPanel({ onExit }: { onExit(warning?: string): void }) {
  // The sink only feeds the in-page Timings view; nothing leaves the browser.
  return <WorkspaceProvider onDiagnostic={editorTimings.onDiagnostic}><Panel onExit={onExit} /></WorkspaceProvider>
}
function Panel({ onExit }: { onExit(warning?: string): void }) {
  const { controller } = useWorkspace()
  return <WorkspaceEditor controller={controller} onExit={onExit} />
}
