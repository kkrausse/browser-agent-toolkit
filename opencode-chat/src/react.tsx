import {
  type ReactNode,
  memo,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  ChatController,
  PermissionRequest,
  QuestionRequest,
  RequestState,
  SessionMessageInfo,
} from "./types";
import { Markdown } from "./markdown";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { ChoiceSelect } from "./components/ui/select";
import { ChoiceGroup } from "./components/ui/choice-group";
export { Markdown, CodeBlock } from "./markdown";
export type OpenFile = (
  path: string,
  selection?: { startLine: number; endLine: number },
) => void;
export interface ChatViewProps {
  controller: ChatController;
  showSessions?: boolean;
  showModels?: boolean;
  onOpenFile?: OpenFile;
  headerActions?: ReactNode;
  footer?: ReactNode;
}
export const useChatSnapshot = (controller: ChatController) =>
  useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
const run = (promise: Promise<unknown>) => {
  void promise.catch(() => {});
};
const pretty = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
type Part = Extract<
  SessionMessageInfo,
  { type: "assistant" }
>["content"][number];

export const ToolCard = memo(function ToolCard({
  part,
  onOpenFile,
}: {
  part: Extract<Part, { type: "tool" }>;
  onOpenFile?: OpenFile;
}) {
  const input = part.state.input;
  const file =
    typeof input === "object" &&
    input &&
    ("path" in input
      ? input.path
      : "filePath" in input
        ? input.filePath
        : undefined);
  return (
    <details className="oc-tool">
      <summary>
        <strong>{part.name}</strong>
        <span>{part.state.status}</span>
      </summary>
      {typeof file === "string" && onOpenFile && (
        <Button type="button" onClick={() => onOpenFile(file)}>
          Open {file}
        </Button>
      )}
      <h4>Input</h4>
      <pre>{pretty(input)}</pre>
      {"content" in part.state && (
        <>
          <h4>Output</h4>
          <pre>
            {part.state.content
              ?.map((content) =>
                content.type === "text" ? content.text : pretty(content),
              )
              .join("\n")}
          </pre>
        </>
      )}
      {"error" in part.state && (
        <pre role="alert">{pretty(part.state.error)}</pre>
      )}
      {"metadata" in part.state &&
        part.state.metadata &&
        Object.keys(part.state.metadata).length > 0 && (
          <details>
            <summary>Details / changes</summary>
            <pre>{pretty(part.state.metadata)}</pre>
          </details>
        )}
    </details>
  );
});
export const MessagePart = memo(function MessagePart({
  part,
  onOpenFile,
}: {
  part: Part;
  onOpenFile?: OpenFile;
}) {
  if (part.type === "text") return <Markdown text={part.text} />;
  if (part.type === "reasoning")
    return (
      <details className="oc-reasoning">
        <summary>Reasoning</summary>
        <Markdown text={part.text} />
      </details>
    );
  if (part.type === "tool")
    return <ToolCard part={part} onOpenFile={onOpenFile} />;
  return <pre>{pretty(part)}</pre>;
});
const MessageRow = memo(function MessageRow({
  message,
  onOpenFile,
  continuation = false,
}: {
  message: SessionMessageInfo;
  onOpenFile?: OpenFile;
  continuation?: boolean;
}) {
  return (
    <article
      className={`oc-message oc-message-${message.type}${continuation ? " oc-message-continuation" : ""}`}
      aria-label={`${message.type} message`}
    >
      {!continuation && <div className="oc-role">
        {message.type === "user"
          ? "You"
          : message.type === "assistant"
            ? "OpenCode"
            : message.type}
      </div>}
      {"text" in message && <Markdown text={message.text} />}
      {message.type === "assistant" &&
        <div className="oc-message-parts">{message.content.map((part, i) => (
          <MessagePart
            key={part.type === "tool" ? part.id : `${part.type}-${i}`}
            part={part}
            onOpenFile={onOpenFile}
          />
        ))}</div>}
      {"files" in message &&
        message.files?.map((file, i) => (
          <div key={i} className="oc-file">
            {file.name || file.mime}
            {onOpenFile &&
              file.source?.type === "uri" &&
              file.source.uri.startsWith("file://") && (
                <Button
                  onClick={() =>
                    onOpenFile(
                      decodeURIComponent(
                        new URL(
                          file.source!.type === "uri"
                            ? file.source!.uri
                            : "file:///",
                        ).pathname,
                      ),
                    )
                  }
                >
                  Open file
                </Button>
              )}
          </div>
        ))}
      {"error" in message && message.error && (
        <pre role="alert">{pretty(message.error)}</pre>
      )}
      {message.type === "assistant" && message.retry && (
        <p role="status">
          Retry {message.retry.attempt}: {pretty(message.retry.error)}
        </p>
      )}
      {message.type !== "assistant" && !("text" in message) && (
        <pre>{pretty(message)}</pre>
      )}
    </article>
  );
});
export function Transcript({
  controller,
  onOpenFile,
}: {
  controller: ChatController;
  onOpenFile?: OpenFile;
}) {
  const state = useChatSnapshot(controller),
    viewport = useRef<HTMLDivElement>(null),
    following = useRef(true);
  const anchor = useRef<{ height: number; top: number } | null>(null),
    session = useRef(state.sessionID);
  const [away, setAway] = useState(false);
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    if (session.current !== state.sessionID) {
      session.current = state.sessionID;
      following.current = true;
      anchor.current = null;
    }
    if (anchor.current && !state.loadingOlder) {
      el.scrollTop =
        anchor.current.top + el.scrollHeight - anchor.current.height;
      anchor.current = null;
    } else {
      const selection = el.ownerDocument.getSelection();
      if (
        selection &&
        !selection.isCollapsed &&
        el.contains(selection.anchorNode)
      )
        following.current = false;
      if (following.current) el.scrollTop = el.scrollHeight;
    }
    setAway(!following.current);
  }, [state.messages, state.sessionID, state.loadingOlder]);
  return (
    <div className="oc-transcript-wrap">
      <div
        className="oc-transcript"
        ref={viewport}
        role="log"
        aria-label="Conversation"
        aria-live="off"
        onScroll={() => {
          const el = viewport.current!;
          following.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 64;
          setAway(!following.current);
        }}
      >
        {state.hasOlder && (
          <Button
            disabled={state.loadingOlder}
            onClick={() => {
              const el = viewport.current!;
              anchor.current = { height: el.scrollHeight, top: el.scrollTop };
              following.current = false;
              run(controller.loadOlder());
            }}
          >
            {state.loadingOlder ? "Loading…" : "Load earlier messages"}
          </Button>
        )}
        {state.loading && (
          <p className="oc-empty" role="status">
            Loading conversation…
          </p>
        )}
        {!state.loading && !state.messages.length && (
          <div className="oc-empty">
            <h3>
              {state.sessionID
                ? "What would you like to build?"
                : "Start a conversation"}
            </h3>
            <p>
              {state.sessionID
                ? "Ask a question, explore your code, or describe a change."
                : "Choose a session or create a new chat above."}
            </p>
          </div>
        )}
        {state.messages.map((message, index) => (
          <MessageRow
            key={message.id}
            message={message}
            onOpenFile={onOpenFile}
            continuation={message.type === "assistant" && state.messages[index - 1]?.type === "assistant"}
          />
        ))}
      </div>
      {away && (
        <Button
          className="oc-latest"
          onClick={() => {
            following.current = true;
            viewport.current!.scrollTop = viewport.current!.scrollHeight;
            setAway(false);
          }}
        >
          Jump to latest ↓
        </Button>
      )}
    </div>
  );
}
export function PermissionCard({
  controller,
  entry,
}: {
  controller: ChatController;
  entry: RequestState<PermissionRequest>;
}) {
  return (
    <section className="oc-request" aria-label="Permission request">
      <strong>Permission needed: {entry.request.action}</strong>
      <pre>{entry.request.resources.join("\n")}</pre>
      <div className="oc-actions">
        {(
          [
            ["once", "Allow once"],
            ["always", "Always allow"],
            ["reject", "Reject"],
          ] as const
        ).map(([decision, label]) => (
          <Button
            key={decision}
            disabled={entry.submitting}
            onClick={() =>
              run(controller.replyPermission(entry.request.id, decision))
            }
          >
            {label}
          </Button>
        ))}
      </div>
      {entry.error && (
        <p role="alert">{entry.error} — choose a response to retry.</p>
      )}
    </section>
  );
}
export function QuestionCard({
  controller,
  entry,
}: {
  controller: ChatController;
  entry: RequestState<QuestionRequest>;
}) {
  const [answers, setAnswers] = useState<string[][]>(() =>
      entry.request.questions.map(() => []),
    ),
    [custom, setCustom] = useState<Record<number, string>>({});
  const complete = entry.request.questions.map((q, i) =>
    custom[i]?.trim()
      ? q.multiple
        ? [...answers[i]!, custom[i]!.trim()]
        : [custom[i]!.trim()]
      : answers[i]!,
  );
  return (
    <form
      className="oc-request"
      onSubmit={(e) => {
        e.preventDefault();
        run(controller.replyQuestion(entry.request.id, complete));
      }}
    >
      {entry.request.questions.map((q, i) => (
        <fieldset key={i} disabled={entry.submitting}>
          <legend>
            {q.header}: {q.question}
          </legend>
          <ChoiceGroup label={q.question} name={`${entry.request.id}-${i}`} options={q.options} value={answers[i] ?? []} multiple={q.multiple} disabled={entry.submitting}
            onValueChange={value => {
              setAnswers(previous => previous.map((answer, index) => index === i ? value : answer));
              if (!q.multiple) setCustom(previous => ({ ...previous, [i]: "" }));
            }}
          />
          {q.custom !== false && (
            <label>
              Custom answer
              <Input
                value={custom[i] ?? ""}
                onChange={(e) => {
                  setCustom((c) => ({ ...c, [i]: e.target.value }));
                  if (!q.multiple)
                    setAnswers((a) => a.map((v, j) => (i === j ? [] : v)));
                }}
              />
            </label>
          )}
        </fieldset>
      ))}
      <div className="oc-actions">
        <Button
          type="submit"
          disabled={entry.submitting || complete.some((a) => !a.length)}
        >
          Submit answers
        </Button>
        <Button
          type="button"
          disabled={entry.submitting}
          onClick={() => run(controller.rejectQuestion(entry.request.id))}
        >
          Skip
        </Button>
      </div>
      {entry.error && <p role="alert">{entry.error} — you can retry.</p>}
    </form>
  );
}
export function Composer({ controller }: { controller: ChatController }) {
  const state = useChatSnapshot(controller),
    [text, setText] = useState("");
  const disabled =
    !state.sessionID ||
    state.connection !== "connected" ||
    state.loading ||
    state.sending ||
    state.execution !== "idle";
  const send = () => {
    if (disabled || !text.trim()) return;
    const draft = text;
    void controller.send({ text: draft }).then(
      () => setText((current) => (current === draft ? "" : current)),
      () => {},
    );
  };
  return (
    <form
      className="oc-composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <Textarea
        aria-label="Message OpenCode"
        placeholder="Message OpenCode…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (
            e.key === "Enter" &&
            !e.shiftKey &&
            !e.nativeEvent.isComposing &&
            e.nativeEvent.keyCode !== 229
          ) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="oc-actions">
        <small>Enter to send · Shift+Enter for a new line</small>
        {state.execution !== "idle" && state.sessionID ? (
          <Button
            type="button"
            disabled={state.connection !== "connected"}
            onClick={() => run(controller.interrupt())}
          >
            {state.interruptRequested ? "Stop requested · Retry" : "Stop"}
          </Button>
        ) : (
          <Button variant="default" type="submit" disabled={disabled || !text.trim()}>
            {state.sending ? "Sending…" : "Send ↑"}
          </Button>
        )}
      </div>
    </form>
  );
}
/** Unmount only unsubscribes. The host owns and disposes the supplied controller. */
export function ChatView({
  controller,
  showSessions = true,
  showModels = true,
  onOpenFile,
  headerActions,
  footer,
}: ChatViewProps) {
  const state = useChatSnapshot(controller);
  const showConnection = !footer || state.connection !== "connected" || state.execution !== "idle";
  return (
    <section className="oc-chat" aria-label="OpenCode chat">
      <header className="oc-header">
        <div className="oc-toolbar">
          <div className="oc-toolbar-copy">
            <strong>OpenCode</strong>
            {(showSessions || showModels) && (
              <details className="oc-settings">
                <summary>Session & model</summary>
                <ChatSettings controller={controller} showSessions={showSessions} showModels={showModels} />
              </details>
            )}
          </div>
          {headerActions}
        </div>
      </header>
      {state.error && (
        <div className="oc-error" role="alert">
          <span>{state.error}</span>
          <Button onClick={() => controller.clearError()}>Dismiss</Button>
        </div>
      )}
      <Transcript controller={controller} onOpenFile={onOpenFile} />
      <div className="oc-requests">
        {state.permissions.map((entry) => <PermissionCard key={entry.request.id} controller={controller} entry={entry} />)}
        {state.unsupportedForms.map(form => (
          <div role="alert" key={form.id}>
            <strong>{form.title}</strong>: This form cannot be answered by this chat client.
            Open it in a compatible OpenCode client to continue. Unsupported fields: {form.fields.map(f => `${f.key} (${f.type})`).join(", ")}.
          </div>
        ))}
        {state.questions.map((entry) => <QuestionCard key={entry.request.id} controller={controller} entry={entry} />)}
      </div>
      <Composer key={state.sessionID ?? "none"} controller={controller} />
      <footer className="oc-footer">
        {showConnection && (
          <div className="oc-connection"><span role="status">
            {state.connection === "connected"
              ? state.execution === "idle"
                ? "Ready"
                : state.execution === "unknown"
                  ? "Checking execution…"
                  : state.execution === "retrying"
                    ? "Retrying…"
                    : "Working…"
              : state.connection}
          </span>
          {state.connection !== "connected" && state.connection !== "connecting" && <Button
            onClick={() => run(controller.reconnect())}
          >
            Reconnect
          </Button>}</div>
        )}
        {footer}
      </footer>
    </section>
  );
}

function ChatSettings({ controller, showSessions, showModels }: ChatViewProps) {
  const state = useChatSnapshot(controller);
  return (
        <nav className="oc-controls" aria-label="Chat settings">
          {showSessions && (
            <>
              <label>
                Session
                <ChoiceSelect
                  label="Session"
                  value={state.sessionID ?? ""}
                  onValueChange={(value) =>
                    run(controller.selectSession(value))
                  }
                  placeholder="Select session"
                  items={state.sessions.map(s => ({ value: s.id, label: s.title || s.id }))}
                />
              </label>
              <Button
                disabled={state.connection !== "connected" || state.loading}
                onClick={() => run(controller.createSession())}
              >
                New chat
              </Button>
            </>
          )}
          {showModels && (
            <label>
              Model
              <ChoiceSelect
                label="Model"
                disabled={
                  !state.sessionID ||
                  state.connection !== "connected" ||
                  state.execution !== "idle"
                }
                value={
                  state.model
                    ? JSON.stringify({
                        providerID: state.model.providerID,
                        id: state.model.id,
                      })
                    : ""
                }
                onValueChange={(value) =>
                  run(controller.selectModel(JSON.parse(value)))
                }
                placeholder="Server default"
                items={state.models
                  .filter((m) => m.enabled)
                  .map((m) => ({
                      value: JSON.stringify({
                        providerID: m.providerID,
                        id: m.id,
                      }),
                      label: `${m.name} · ${m.providerID}`,
                  }))}
              />
            </label>
          )}
        </nav>
  );
}
