// The chat: header (sessions), transcript, pending requests, composer, status.
// transcript.tsx scrolls, parts.tsx lays a session out as rows, tools.tsx, notices.tsx and
// requests.tsx draw them, composer.tsx sends. Colours are tokens (styles.css): light and
// dark, by the system's preference unless the host says otherwise.
import { useRef, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { isPreparing, type ChatController, type ChatSnapshot } from "@kkrausse/browser-agent-toolkit/browser";
import { Composer } from "./composer";
import { run, useChatSnapshot, type OpenFile } from "./hooks";
import { FormCard, PermissionCard } from "./requests";
import { ChatThemeProvider, useResolvedScheme } from "./theme";
import { Transcript } from "./transcript";
import { Button } from "./ui/button";
import { ChoiceSelect } from "./ui/select";

export { Markdown, CodeBlock } from "./markdown";
export { Transcript } from "./transcript";
export { Composer } from "./composer";
export { PermissionCard, FormCard } from "./requests";
export { ToolRow, ToolRun } from "./tools";
export { useChatSnapshot, useChatState, type OpenFile } from "./hooks";

export interface ChatViewProps {
  controller: ChatController;
  showSessions?: boolean;
  showModels?: boolean;
  showHeader?: boolean;
  showTitle?: boolean;
  showFooter?: boolean;
  /** `light` or `dark` fixes the scheme; by default it follows the system's preference,
   * or a `data-theme` attribute or `light`/`dark` class on an ancestor. */
  theme?: "light" | "dark";
  onOpenFile?: OpenFile;
  headerActions?: ReactNode;
  footer?: ReactNode;
}

/** A failed hydrate leaves execution unknown with nothing in flight. Without a retry the
 * composer would stay as it is until the next server event, if any. */
const isStalled = (state: ChatSnapshot) => state.connection === "connected" && state.execution === "unknown" &&
  !state.loading && !state.sending && !state.sessionOperationPending && !state.held;

function statusOf(state: ChatSnapshot): string {
  if (state.connection !== "connected") {
    if (state.connection === "disconnected") return "Disconnected";
    // The first connection, or one being made again: the data layer does that by itself.
    return state.connectionState.attempt > 1 || state.messages.length ? "Reconnecting…" : "Connecting…";
  }
  if (state.held) return `Paused: ${state.held}`;
  if (isPreparing(state)) return "Preparing chat…";
  if (state.execution === "idle") return state.sending ? "Sending…" : "Ready";
  if (state.execution === "unknown") return isStalled(state) ? "Execution state unknown" : "Checking execution…";
  return state.execution === "retrying" ? "Retrying…" : "Working…";
}

/** Unmount only unsubscribes. The host owns and disposes the supplied controller. */
export function ChatView({
  controller, showSessions = true, showModels = true, showHeader = true, showTitle = true, showFooter = true,
  theme, onOpenFile, headerActions, footer,
}: ChatViewProps) {
  const state = useChatSnapshot(controller);
  const root = useRef<HTMLElement>(null);
  const scheme = useResolvedScheme(root);
  const status = statusOf(state), stalled = isStalled(state);
  // Quiet: a chat that is ready, or working with its work on screen, says nothing here.
  const quiet = status === "Ready" || status === "Working…" || status === "Retrying…" || status === "Sending…";
  return <ChatThemeProvider value={scheme}>
    <section className="oc-chat" aria-label="OpenCode chat" ref={root} data-theme={theme}>
      {showHeader && (showTitle || showSessions || headerActions) && <header className="oc-header">
        {showTitle && <strong>OpenCode</strong>}
        {showSessions && <>
          <ChoiceSelect label="Session" className="oc-session" disabled={!!state.held} value={state.sessionID ?? ""}
            onValueChange={value => run(controller.selectSession(value))}
            placeholder={state.sessionOperationPending ? "New chat" : "Select a session"}
            items={state.sessions.map(session => ({ value: session.id, label: session.title || "Untitled chat" }))} />
          <Button variant="ghost" size="icon" aria-label="New chat" title="New chat"
            disabled={state.connection !== "connected" || state.loading || state.sessionOperationPending || !!state.held}
            onClick={() => run(controller.createSession())}><Plus aria-hidden="true" /></Button>
        </>}
        <span className="oc-header-space" />
        {headerActions}
      </header>}
      {state.error && <div className="oc-error" role="alert">
        <span>{state.error}</span>
        <Button variant="ghost" size="sm" onClick={() => controller.clearError()}>Dismiss</Button>
      </div>}
      <Transcript controller={controller} onOpenFile={onOpenFile} />
      {(state.permissions.length > 0 || state.forms.length > 0) && <div className="oc-requests">
        {state.permissions.map(entry => <PermissionCard key={entry.request.id} controller={controller} entry={entry} />)}
        {state.forms.map(entry => <FormCard key={entry.request.id} controller={controller} entry={entry} />)}
      </div>}
      <Composer controller={controller} showModels={showModels} />
      {showFooter && <footer className="oc-footer" data-quiet={(quiet && !footer) || undefined}>
        <div className="oc-connection" data-quiet={quiet || undefined}>
          <span role="status">{status}</span>
          {state.connection === "disconnected" && <Button size="sm" disabled={!!state.held} onClick={() => run(controller.reconnect())}>Reconnect</Button>}
          {stalled && <Button size="sm" onClick={() => run(state.sessionID ? controller.selectSession(state.sessionID) : controller.reconnect())}>Retry</Button>}
        </div>
        {footer}
      </footer>}
    </section>
  </ChatThemeProvider>;
}
