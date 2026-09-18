import { PreparedBrowserEditor } from '@kev-browser-agent-kit/opencode-chat/editor'
import { startBrowserEditor } from './start-editor'
import '@kev-browser-agent-kit/opencode-chat/editor.css'
import './editor-panel.css'

const hostPaths = ['/api']
const isPreviewReady = (frame: HTMLIFrameElement) => !!frame.contentDocument?.querySelector('main input#title:not(:disabled)')

export default function EditorPanel({ onExit }: { onExit(): void }) {
  return <div className="todo-editor-sidebar">
    <PreparedBrowserEditor layout="sidebar" hostPaths={hostPaths} start={startBrowserEditor}
      isPreviewReady={isPreviewReady} onExit={onExit} />
  </div>
}
