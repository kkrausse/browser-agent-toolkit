// The rows of one session's transcript, the same for the conversation and for a subagent
// session opened under its call.
import { memo, useEffect, useRef, useState } from "react";
import { Bot, ChevronRight, CircleAlert, FileText, LoaderCircle } from "lucide-react";
import {
  activityOf, executionOf, subagentOf,
  type Activity, type ChatController, type Message, type SessionState, type ToolPart,
} from "@kkrausse/browser-agent-toolkit/browser";
import { formatBytes, run, useChatState, type OpenFile } from "./hooks";
import { layout, reconcile, type Item, type Row } from "./layout";
import { Markdown } from "./markdown";
import { ErrorNotice, Notice, RetryNotice } from "./notices";
import { ToolRow, ToolRun, inputOf, shortPath } from "./tools";
import { Button } from "./ui/button";

type User = Extract<Message, { type: "user" }>;
type Attachment = NonNullable<User["files"]>[number];

const base64Bytes = (data: string) => Math.max(0, Math.floor(data.length * 3 / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0));
export function AttachmentChip({ file, onOpenFile }: { file: Attachment; onOpenFile?: OpenFile }) {
  const name = file.name || file.mime;
  const path = file.source.type === "uri" && file.source.uri.startsWith("file://") ? decodeURIComponent(new URL(file.source.uri).pathname) : undefined;
  return <span className="oc-chip" title={path ?? name}>
    {file.mime.startsWith("image/") && file.data
      ? <img src={`data:${file.mime};base64,${file.data}`} alt="" loading="lazy" />
      : <FileText aria-hidden="true" />}
    <span className="oc-chip-name">{name}</span>
    <span className="oc-chip-size">{formatBytes(base64Bytes(file.data))}</span>
    {path && onOpenFile && <Button type="button" variant="ghost" size="sm" onClick={() => onOpenFile(path)}>Open</Button>}
  </span>;
}

const UserRow = memo(function UserRow({ message, sending, onOpenFile }: { message: User; sending: boolean; onOpenFile?: OpenFile }) {
  return <article className="oc-row oc-message oc-message-user" aria-label="user message" data-sending={sending || undefined}>
    {message.text && <div className="oc-user-text">{message.text}</div>}
    {!!message.files?.length && <div className="oc-chips">{message.files.map((file, index) => <AttachmentChip key={index} file={file} onOpenFile={onOpenFile} />)}</div>}
  </article>;
});

const ItemRow = memo(function ItemRow({ controller, sessionID, item, onOpenFile }: { controller: ChatController; sessionID: string; item: Item; onOpenFile?: OpenFile }) {
  switch (item.kind) {
    case "text": return <div className="oc-row"><Markdown text={item.text} live={item.live} /></div>;
    case "tool": return <div className="oc-row"><ToolRow part={item.part} onOpenFile={onOpenFile} /></div>;
    case "tools": return <div className="oc-row"><ToolRun parts={item.parts} onOpenFile={onOpenFile} /></div>;
    case "subagent": return <div className="oc-row"><SubagentCard controller={controller} sessionID={sessionID} messageID={item.messageID} part={item.part} onOpenFile={onOpenFile} /></div>;
    case "error": return <div className="oc-row"><ErrorNotice error={item.error} /></div>;
    case "retry": return <div className="oc-row"><RetryNotice retry={item.retry} /></div>;
  }
});

const RowView = memo(function RowView({ controller, sessionID, row, onOpenFile }: { controller: ChatController; sessionID: string; row: Row; onOpenFile?: OpenFile }) {
  switch (row.kind) {
    case "user": return <UserRow message={row.message} sending={row.sending} onOpenFile={onOpenFile} />;
    case "turn": return <article className="oc-message oc-message-assistant" aria-label="assistant message">
      {row.items.map(item => <ItemRow key={item.key} controller={controller} sessionID={sessionID} item={item} onOpenFile={onOpenFile} />)}
    </article>;
    case "notice": return <Notice controller={controller} message={row.message} />;
    case "failure": return <div className="oc-row"><ErrorNotice error={row.error} title="The run failed" /></div>;
  }
});

/** The session's rows, laid out again when the session changes; rows and items that did
 * not change keep their identity, so only what changed renders. */
export function useRows(session: SessionState | undefined): readonly Row[] {
  const last = useRef<{ session?: SessionState; rows: readonly Row[] }>({ rows: [] });
  if (last.current.session !== session)
    last.current = { session, rows: session ? reconcile(last.current.rows, layout(session)) : [] };
  return last.current.rows;
}

/** While the model works and nothing on screen shows it: one plain line. */
function ActivityLine({ session }: { session: SessionState }) {
  if (executionOf(session) !== "running") return null;
  const activity = activityOf(session);
  if (activity.kind !== "reasoning" && activity.kind !== "working") return null;
  return <div className="oc-activity" role="status"><LoaderCircle aria-hidden="true" className="oc-spin" />Thinking</div>;
}

export function SessionRows({ controller, sessionID, onOpenFile }: { controller: ChatController; sessionID: string; onOpenFile?: OpenFile }) {
  const session = useChatState(controller, state => state.sessions[sessionID]);
  const rows = useRows(session);
  return <>
    {rows.map(row => <RowView key={row.key} controller={controller} sessionID={sessionID} row={row} onOpenFile={onOpenFile} />)}
    {session && <ActivityLine session={session} />}
  </>;
}

// ---- subagents -------------------------------------------------------------

const firstLine = (text: string | undefined) => text?.trim().split("\n").findLast(line => line.trim())?.trim();
function toolLine(part: ToolPart): string {
  const input = inputOf(part);
  const subject = [input.command, input.path, input.filePath, input.pattern, input.url, input.query, input.description].find(value => typeof value === "string" && value) as string | undefined;
  return `${part.name}${subject ? ` · ${shortPath(subject.split("\n", 1)[0]!)}` : ""}`;
}
/** What the child session is doing now, as one line. */
export function describeActivity(activity: Activity): { text: string; waiting?: boolean; failed?: boolean } | undefined {
  switch (activity.kind) {
    case "permission": return { text: `Waiting for your permission: ${activity.request.action}`, waiting: true };
    case "form": return { text: `Waiting for your answer: ${activity.form.title || "a question"}`, waiting: true };
    case "retry": return { text: `Attempt ${activity.attempt} failed, trying again: ${activity.message}` };
    case "tool": return { text: toolLine(activity.part) };
    case "reasoning": case "working": return { text: "Thinking" };
    case "text": return { text: firstLine(activity.text) ?? "Writing" };
    case "failed": return { text: activity.message, failed: true };
    case "idle": return activity.outcome === "interrupted" ? { text: "Stopped" }
      : activity.outcome === "failed" ? { text: "Failed", failed: true }
      : activity.text ? { text: firstLine(activity.text)! } : undefined;
    case "unknown": return undefined;
  }
}

/** A subagent call: who runs, what it does now, and its whole transcript on request. */
export const SubagentCard = memo(function SubagentCard({ controller, sessionID, messageID, part, onOpenFile }: {
  controller: ChatController; sessionID: string; messageID: string; part: ToolPart; onOpenFile?: OpenFile;
}) {
  const [open, setOpen] = useState(false);
  // Rebuilt on every change of the state, compared by what the card shows.
  const call = useChatState(controller, state => subagentOf(state, sessionID, messageID, part.id),
    (a, b) => a?.childID === b?.childID && a?.child === b?.child && a?.running === b?.running && a?.part === b?.part);
  const childID = call?.childID, child = call?.child;
  const stopping = useChatState(controller, state => !!childID && state.interrupting.includes(childID));
  useEffect(() => { if (open && childID) run(controller.loadSession(childID)); }, [open, childID, controller]);
  const failed = part.state.status === "error";
  const running = !!call?.running && !failed;
  const activity = child ? describeActivity(activityOf(child)) : running ? { text: "Starting" } : undefined;
  const Icon = failed ? CircleAlert : running ? LoaderCircle : Bot;
  return <div className="oc-subagent" data-running={running || undefined}>
    <button type="button" className="oc-tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Icon aria-hidden="true" className={running ? "oc-spin" : undefined} />
      <span className="oc-tool-verb">Subagent{call?.agent ? ` ${call.agent}` : ""}</span>
      {call?.description && <span className="oc-subagent-title">{call.description}</span>}
      {call?.background && running && <span className="oc-tool-extra">in the background</span>}
      <ChevronRight aria-hidden="true" className="oc-chevron" />
    </button>
    {failed && "error" in part.state && <p className="oc-tool-error" role="alert">{part.state.error.message}</p>}
    {activity && !open && <p className="oc-subagent-activity" data-waiting={activity.waiting || undefined} data-failed={activity.failed || undefined} role="status">{activity.text}</p>}
    {open && <div className="oc-subagent-body">
      {!childID ? <p className="oc-muted">The subagent's session has not been reported yet.</p>
        : !child?.loaded ? <p className="oc-muted" role="status">Loading the subagent's conversation…</p>
        : <>
          {child.older && <Button type="button" variant="ghost" size="sm" disabled={child.loadingOlder} onClick={() => run(controller.loadOlder(childID))}>{child.loadingOlder ? "Loading…" : "Load earlier messages"}</Button>}
          <SessionRows controller={controller} sessionID={childID} onOpenFile={onOpenFile} />
          {!child.order.length && <p className="oc-muted">Nothing yet.</p>}
        </>}
      {running && childID && <div className="oc-actions"><Button type="button" size="sm" onClick={() => run(controller.interrupt(childID))}>{stopping ? "Stopping…" : "Stop this subagent"}</Button></div>}
    </div>}
  </div>;
});
