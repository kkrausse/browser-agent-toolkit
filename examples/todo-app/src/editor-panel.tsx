import { WorkspaceProvider, useWorkspace } from '@kev-browser-agent-kit/workspace/react'
import { WorkspaceEditor } from './workspace-editor'
import './editor-panel.css'

export default function EditorPanel({ onExit }: { onExit(): void }) {
  return <WorkspaceProvider><Panel onExit={onExit} /></WorkspaceProvider>
}
function Panel({ onExit }: { onExit(): void }) {
  const { controller } = useWorkspace()
  return <WorkspaceEditor controller={controller} onExit={onExit} />
}
