import { useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceController } from '@kev-browser-agent-kit/workspace/react';
import { BrowserEditor } from '../../../opencode-chat/src/editor';
import { startBrowserEditor } from '../src/start-editor';
import '../../../opencode-chat/src/styles.css';
import '../../../opencode-chat/src/editor.css';

const controller = new WorkspaceController({ captureProcessOutput: true });

function LiveApp() {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [opened, setOpened] = useState(false);
  const [path, setPath] = useState('/src/home.tsx');
  const [contents, setContents] = useState('');
  const [loadedPath, setLoadedPath] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  async function fileAction(save: boolean) {
    setBusy(true);
    try {
      if (!controller.workspace) throw Error('Open the workspace first');
      if (save) {
        if (loadedPath !== path) throw Error('Load the selected path before saving');
        await controller.workspace.fs.writeFile(path, contents);
        await controller.workspace.flush();
        setStatus('Saved locally and flushed. Vite updates the preview through HMR.');
      } else {
        const bytes = await controller.workspace.fs.readFile(path);
        setContents(new TextDecoder().decode(bytes)); setLoadedPath(path);
        setStatus('Loaded workspace source. Save explicitly; unsaved text is not persisted.');
      }
    } catch (error) { setStatus(String(error)); }
    finally { setBusy(false); }
  }
  return <>
    <header className="live-toolbar"><strong>Single-kernel TODO + OpenCode · live exploration</strong>
      {!opened && <button onClick={() => setOpened(true)}>Open editor</button>}
      <span>Source and chat stay local to this browser origin. TODO data stays in server memory.</span>
    </header>
    {opened ? <div className="live-editor"><BrowserEditor controller={controller} layout="sidebar"
      recipe={{ start: startBrowserEditor }} hostPaths={['/api']}
      isPreviewReady={frame => !!frame.contentDocument?.querySelector('main input#title:not(:disabled)')}
      onExit={async () => { await controller.cancelAndClose(); setOpened(false); }} /></div>
      : <p>Choose Open editor to boot the durable workspace, Vite TODO preview and OpenCode server. No automated E2E stages run.</p>}
    <details className="live-source"><summary>Source editor (explicit local save)</summary>
      <label>Workspace-relative path <input value={path} onChange={event => setPath(event.target.value)} /></label>
      <button disabled={!state.workspace || state.busy || busy} onClick={() => void fileAction(false)}>Load file</button>
      <button disabled={!state.workspace || state.busy || busy || loadedPath !== path} onClick={() => void fileAction(true)}>Save and flush</button>
      <p role="status">{status}</p>
      <textarea aria-label="File contents" spellCheck={false} value={contents} onChange={event => setContents(event.target.value)} />
    </details>
  </>;
}

createRoot(document.getElementById('root')!).render(<LiveApp />);
