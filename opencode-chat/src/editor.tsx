import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { WorkspaceProvider, useWorkspace, type ControllerDiagnosticOptions, type Service, type WorkspaceController } from "@kev-browser-agent-kit/workspace/react";
import type { ChatController } from "./types";
import { ChatView } from "./react";
import { attachChat, editorLifecycle } from "./editor-adapter";
import { Button } from "./components/ui/button";
import { createBrowserEditorDiagnostics } from './diagnostics';
export { attachChat, chatFor, type WorkspaceChatOptions } from "./editor-adapter";
export { sourcePaths } from "./editor-source";

export interface BrowserEditorProps {
  controller: WorkspaceController;
  /** Sidebar fills its host; floating overlays the preview. */
  layout?: "floating" | "sidebar";
  /** Supply to start on mount and close on unmount. Omit for host-managed lifecycle. */
  recipe?: { start(controller: WorkspaceController): Promise<void> };
  onExit?(): void;
  onRetry?(): void;
  /** Optional host recipe action; does not imply remote archival/reset semantics. */
  onReset?(): Promise<void>;
  previewService?: string;
  chatService?: string;
  directory?: string;
  hostPaths?: string[];
  /** Optional application-specific rendered-content check. Default: iframe load. */
  isPreviewReady?(frame: HTMLIFrameElement): boolean;
}
export type PreparedBrowserEditorProps = Omit<BrowserEditorProps, "controller" | "recipe"> & ControllerDiagnosticOptions & {
  /** Prepared assets, runtime and model proxy root. Default: /editor/. Captured on mount. */
  base?: string;
  /** Application-owned startup. Captured on mount; start preview and OpenCode explicitly. */
  start(controller: WorkspaceController): Promise<void>;
  /** Auto-discover the server's diagnostics switch (default). False disables browser delivery. */
  diagnostics?: boolean;
};
export type PreparedBrowserWorkspaceProps = ControllerDiagnosticOptions & {
  children: ReactNode;
  /** Prepared assets, runtime and model proxy root. Default: /editor/. Captured on mount. */
  base?: string;
  /** Application-owned startup. Captured on mount. */
  start(controller: WorkspaceController): Promise<void>;
  /** Auto-discover the server's diagnostics switch (default). False disables browser delivery. */
  diagnostics?: boolean;
};

/** Mount only while editing is authorized and open. Composes the default prepared
 * recipe and workspace lifecycle; the host owns authorization and the launcher. */
export function PreparedBrowserEditor({ onDiagnostic, captureProcessOutput, diagnostics, ...props }: PreparedBrowserEditorProps) {
  return <PreparedBrowserWorkspace base={props.base} start={props.start} diagnostics={diagnostics} onDiagnostic={onDiagnostic} captureProcessOutput={captureProcessOutput}>
    <PreparedEditor {...props} />
  </PreparedBrowserWorkspace>;
}

function PreparedEditor({ start: _start, base: _base, ...props }: PreparedBrowserEditorProps) {
  const { controller } = useWorkspace();
  return <BrowserEditor {...props} controller={controller} />;
}

export function PreparedBrowserWorkspace({ children, start, base, diagnostics, onDiagnostic, captureProcessOutput }: PreparedBrowserWorkspaceProps) {
  const [client] = useState(() => createBrowserEditorDiagnostics({ base, enabled: diagnostics, onDiagnostic }));
  return <WorkspaceProvider onDiagnostic={client.onDiagnostic} captureProcessOutput={captureProcessOutput ?? (() => client.enabled)}>
    <PreparedWorkspaceLifecycle start={start} diagnosticClient={client}>{children}</PreparedWorkspaceLifecycle>
  </WorkspaceProvider>;
}

function PreparedWorkspaceLifecycle({ start, diagnosticClient: client, children }: { start(controller: WorkspaceController): Promise<void>; diagnosticClient: ReturnType<typeof createBrowserEditorDiagnostics>; children: ReactNode }) {
  const { controller } = useWorkspace();
  const mounts = useRef(0);
  useEffect(() => {
    mounts.current++;
    let cancelled = false;
    const detach = client.attach(window);
    void client.connect().then(() => { if (!cancelled) client.record('editor.mounted', { path: location.pathname }); });
    return () => {
      detach(); cancelled = true; mounts.current--;
      queueMicrotask(() => {
        if (!mounts.current) void controller.dispose().catch(error => client.record('editor.cleanup.failed', error)).finally(async () => {
          client.record('editor.unmounted'); await client.dispose();
        });
      });
    };
  }, [client, controller]);
  const [recipe] = useState(() => {
    return { async start(owner: WorkspaceController) { await client.connect(); await start(owner); } };
  });
  useEffect(() => editorLifecycle(controller, recipe.start), [controller, recipe]);
  return children;
}

const noHostPaths: string[] = [];
export function BrowserEditor({ controller, layout = "floating", recipe, onExit, onRetry, onReset, previewService = "vite", chatService = "chat", directory = "/workspace", hostPaths = noHostPaths, isPreviewReady }: BrowserEditorProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const start = useRef(recipe); start.current = recipe;
  const [retry, setRetry] = useState(0);
  const panel = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const resize = (width: number, height: number) => {
    if (!panel.current) return;
    if (layout === "sidebar" && canvas.current) {
      const bounds = canvas.current.getBoundingClientRect();
      if (window.matchMedia("(max-width: 720px)").matches) {
        canvas.current.style.setProperty("--oc-sidebar-height", `${Math.min(bounds.height, Math.max(280, Math.min(bounds.height - 120, height)))}px`);
      } else {
        canvas.current.style.setProperty("--oc-sidebar-width", `${Math.min(bounds.width, Math.max(320, Math.min(bounds.width - 200, width)))}px`);
      }
      return;
    }
    panel.current.style.width = `${Math.max(320, Math.min(window.innerWidth - 32, width))}px`;
    panel.current.style.height = `${Math.max(360, Math.min(window.innerHeight - 32, height))}px`;
  };
  const [exiting, setExiting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const managed = !!recipe;
  useEffect(() => {
    if (managed) return editorLifecycle(controller, owner => start.current!.start(owner));
  }, [controller, managed, retry]);
  const actions = <div className="oc-editor-actions">
        {onReset && <Button disabled={state.busy || exiting || resetting || !state.runtime} onClick={() => { setResetting(true); void Promise.resolve().then(onReset).catch(error => controller.reportError(error)).finally(() => setResetting(false)); }}>Reset source</Button>}
        {onExit && <Button disabled={exiting || resetting} onClick={() => { setExiting(true); void Promise.resolve().then(onExit).catch(error => controller.reportError(error)).finally(() => setExiting(false)); }}>Exit</Button>}
      </div>;
  const footer = <>
      <p role="status">{state.status}</p>
      {state.error && <div role="alert"><p>{state.error}</p>{(managed || onRetry) && <Button disabled={state.busy} onClick={() => onRetry ? onRetry() : setRetry(value => value + 1)}>Retry editing</Button>}</div>}
      <details className="oc-editor-debug"><summary>Debug · Activity</summary>
        <p>Workspace: {state.workspace ? state.persistence : "closed"} · Runtime: {state.runtime ? "active" : "stopped"}</p>
        <Button onClick={() => {
          const log = [`Workspace: ${state.workspace ? state.persistence : "closed"} · Runtime: ${state.runtime ? "active" : "stopped"}`, state.status, state.error, ...state.logs].filter(Boolean).join("\n");
          void Promise.resolve().then(() => navigator.clipboard.writeText(log)).then(() => setCopyStatus("Copied"), () => setCopyStatus("Copy failed — select the log below"));
        }}>Copy log</Button> <span role="status">{copyStatus}</span>
        <p>Recent activity (up to 2,000 entries).</p>
        <pre>{state.logs.join("\n")}</pre>
      </details>
    </>;
  return <div ref={canvas} className={`oc-editor oc-editor-${layout}`}>
    <EditorPreview controller={controller} service={state.services[previewService]} name={previewService} hostPaths={hostPaths} isReady={isPreviewReady} />
    <aside ref={panel} className="oc-editor-panel" aria-label="Editing controls">
      <button className="oc-editor-resize" aria-label="Resize OpenCode panel" title="Drag to resize, or use arrow keys" onPointerDown={event => {
        const rect = panel.current!.getBoundingClientRect();
        drag.current = { x: event.clientX, y: event.clientY, width: rect.width, height: rect.height };
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={event => {
        if (drag.current) resize(drag.current.width + drag.current.x - event.clientX, drag.current.height + drag.current.y - event.clientY);
      }} onPointerUp={event => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        const rect = panel.current!.getBoundingClientRect();
        resize(rect.width + (event.key === "ArrowLeft" ? 24 : event.key === "ArrowRight" ? -24 : 0), rect.height + (event.key === "ArrowUp" ? 24 : event.key === "ArrowDown" ? -24 : 0));
      }} />
      <EditorChat controller={controller} service={state.services[chatService]} name={chatService} directory={directory} headerActions={actions} footer={footer} />
    </aside>
  </div>;
}

export function useWorkspaceChat(controller: WorkspaceController, service: Service | undefined, options: { serviceName?: string; directory?: string } = {}) {
  const name = options.serviceName ?? "chat", directory = options.directory ?? "/workspace";
  const [chat, setChat] = useState<ChatController>(), [error, setError] = useState("");
  useEffect(() => {
    let active = true; setChat(undefined); setError("");
    if (service) void attachChat(controller, service, { serviceName: name, directory }).then(value => { if (active) setChat(value); }, error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [controller, service, name, directory]);
  return { chat, error };
}

function EditorChat({ controller, service, name, directory, headerActions, footer }: { controller: WorkspaceController; service?: Service; name: string; directory: string; headerActions: ReactNode; footer: ReactNode }) {
  const { chat, error } = useWorkspaceChat(controller, service, { serviceName: name, directory });
  return chat ? <ChatView controller={chat} headerActions={headerActions} footer={footer} /> : <section className="oc-chat" aria-label="OpenCode chat">
    <header className="oc-toolbar"><strong>OpenCode</strong>{headerActions}</header>
    <div className="oc-transcript-wrap oc-empty">{error ? <p role="alert">{error}</p> : <p>Waiting for OpenCode connection…</p>}</div>
    <footer className="oc-footer">{footer}</footer>
  </section>;
}

export function EditorPreview({ controller, service, name, hostPaths, isReady }: { controller: WorkspaceController; service?: Service; name: string; hostPaths: string[]; isReady?: BrowserEditorProps["isPreviewReady"] }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    const target = frame.current;
    if (!service || !target) return;
    let observer: MutationObserver | undefined;
    const check = () => {
      try { if (!isReady || isReady(target)) { observer?.disconnect(); setReady(true); controller.clientReady(name); } }
      catch (error) { controller.clientFailed(name, error); }
    };
    const loaded = () => {
      if (target.getAttribute("src") === "about:blank") return;
      // attachPreview navigates through about:blank; ignore its queued load.
      try { if (target.contentWindow?.location.href === "about:blank") return; } catch { /* cross-origin preview */ }
      controller.diagnostic('preview.iframe.loaded', { name });
      if (isReady) {
        try { observer?.disconnect(); observer = new MutationObserver(check); if (target.contentDocument) observer.observe(target.contentDocument, { childList: true, subtree: true }); }
        catch (error) { controller.clientFailed(name, error); }
      }
      check();
    };
    target.addEventListener("load", loaded);
    try {
      controller.diagnostic('preview.iframe.attach', { name });
      const attachment = service.endpoint.attachPreview(target, { hostPaths });
      return controller.registerAttachment(name, () => { observer?.disconnect(); target.removeEventListener("load", loaded); attachment.dispose(); target.src = "about:blank"; });
    } catch (error) { target.removeEventListener("load", loaded); controller.clientFailed(name, error); }
  }, [controller, service, name, hostPaths, isReady]);
  return <iframe className="oc-editor-preview" ref={frame} title="Workspace preview" style={{ visibility: ready ? "visible" : "hidden" }} />;
}
