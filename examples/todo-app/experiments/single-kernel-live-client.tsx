import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkspaceController } from '@kev-browser-agent-kit/workspace/react'
import { WorkspaceEditor } from '../src/workspace-editor'

const controller = new WorkspaceController({ captureProcessOutput: true })
function LiveApp() {
  const [opened, setOpened] = useState(false)
  return opened ? <WorkspaceEditor controller={controller} onExit={() => setOpened(false)} /> : <>
    <header className="live-toolbar"><strong>Single-kernel TODO + OpenCode</strong><button onClick={() => setOpened(true)}>Open editor</button></header>
    <p>Source and native chat sessions stay in this browser origin. TODO items remain in host memory. Open editor adopts your existing working copy without replacing it.</p>
  </>
}
createRoot(document.getElementById('root')!).render(<LiveApp />)
