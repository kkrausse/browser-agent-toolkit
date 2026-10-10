import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { openEditor, type Editor, type EditorSnapshot, type OpenEditorOptions } from './browser';

export { ChatView, Transcript, Composer, useChatSnapshot, type ChatViewProps } from './chat/view';
export type { Editor, EditorSnapshot } from './browser';

const opening: EditorSnapshot = { status: 'opening', message: 'Loading editor…', timings: {}, preview: 'stopped', agent: 'stopped', log: [] };
// One workspace per origin: a new open waits for the previous editor to finish closing
// (React StrictMode mounts twice; a retry follows a close).
let lastClose: Promise<unknown> = Promise.resolve();

export interface UseEditor {
  /** Set once the workspace is booted and both programs are starting. */
  editor?: Editor;
  /** Live from the first moment of the open: status, message, error, timings, log. */
  snapshot: EditorSnapshot;
  /** Close and open again. */
  retry(): void;
}

/** Opens the editor on mount and closes it on unmount. `options` are read once per open. */
export function useEditor(options: Pick<OpenEditorOptions, 'base' | 'boot' | 'onEvent'> = {}): UseEditor {
  const [attempt, setAttempt] = useState(0);
  const [editor, setEditor] = useState<Editor>();
  const [snapshot, setSnapshot] = useState(opening);
  const current = useRef(options); current.current = options;
  useEffect(() => {
    const abort = new AbortController();
    setEditor(undefined); setSnapshot(opening);
    const previous = lastClose;
    let closed!: () => void;
    lastClose = new Promise<void>(resolve => { closed = resolve; });
    void (async () => {
      await previous;
      if (abort.signal.aborted) return closed();
      try {
        const opened = await openEditor({
          ...current.current, signal: abort.signal,
          onEvent(event) {
            if (event.type === 'state' && !abort.signal.aborted) setSnapshot(event.snapshot);
            current.current.onEvent?.(event);
          },
        });
        if (abort.signal.aborted) await opened.close().catch(() => {});
        else {
          setEditor(opened);
          abort.signal.addEventListener('abort', () => void opened.close().catch(() => {}).finally(closed), { once: true });
          return;
        }
      } catch (error) {
        if (!abort.signal.aborted) setSnapshot(value => value.status === 'failed' ? value : { ...value, status: 'failed', message: 'The editor could not open.', error: error instanceof Error ? error.message : String(error) });
      }
      closed();
    })();
    const leave = () => abort.abort();
    window.addEventListener('pagehide', leave);
    return () => { window.removeEventListener('pagehide', leave); abort.abort(); };
  }, [attempt]);
  return { editor, snapshot, retry: () => setAttempt(value => value + 1) };
}

export const useEditorSnapshot = (editor: Editor) => useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);

const noHostPaths: readonly string[] = [];

/**
 * The app's dev server in an iframe. Hidden until `isReady(frame)` says the app is
 * showing (default: the frame's load event), so a half-rendered page never flashes.
 * `hostPaths`: root-absolute prefixes (`/api`) the preview reaches on the real server.
 */
export function EditorPreview({ editor, hostPaths = noHostPaths, isReady, className = 'oc-editor-preview', style }: {
  editor: Editor;
  hostPaths?: readonly string[];
  isReady?(frame: HTMLIFrameElement): boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [visible, setVisible] = useState(false);
  const up = useSyncExternalStore(editor.subscribe, () => editor.snapshot().preview === 'ready');
  const paths = hostPaths.join('\n');
  useEffect(() => { editor.setHostPaths(paths ? paths.split('\n') : []); }, [editor, paths]);
  useEffect(() => {
    const target = frame.current;
    setVisible(false);
    if (!up || !target) return;
    let observer: MutationObserver | undefined;
    const check = () => {
      let ready = false;
      try { ready = !isReady || isReady(target); } catch { /* the frame navigated away */ }
      if (!ready) return;
      observer?.disconnect();
      editor.mark('preview.visible');
      setVisible(true);
    };
    const loaded = () => {
      if (isReady) {
        observer?.disconnect();
        observer = new MutationObserver(check);
        try { if (target.contentDocument) observer.observe(target.contentDocument, { childList: true, subtree: true, attributes: true }); } catch { /* cross-origin */ }
      }
      check();
    };
    target.addEventListener('load', loaded);
    target.src = editor.preview.endpoint.url;
    return () => { observer?.disconnect(); target.removeEventListener('load', loaded); target.src = 'about:blank'; };
  }, [editor, up, isReady]);
  return <iframe ref={frame} className={className} title="App preview" style={{ ...style, visibility: visible ? 'visible' : 'hidden' }} />;
}
