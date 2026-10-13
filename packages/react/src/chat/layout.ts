// What a session's transcript shows, as rows: pure, no React. The grouping rules are the
// view's own, after OpenCode 2.0.26's `session-ui/src/timeline/projection.ts` (context
// groups): consecutive assistant messages are one turn; in a turn, reasoning is left out,
// and a run of finished tool calls with nothing shown between them is one row that counts
// them. A call that is running, failed, edited files or started a subagent is a row of its
// own: it has something to show.
import { pendingStatus, subagentTool, type Message, type SessionState, type StructuredError, type ToolPart } from "@kkrausse/browser-agent-toolkit/browser";

type Assistant = Extract<Message, { type: "assistant" }>;
export type Retry = NonNullable<Assistant["retry"]>;
export type Item =
  | { kind: "text"; key: string; text: string; live: boolean }
  | { kind: "tool"; key: string; part: ToolPart }
  | { kind: "tools"; key: string; parts: readonly ToolPart[] }
  | { kind: "subagent"; key: string; messageID: string; part: ToolPart }
  | { kind: "error"; key: string; error: StructuredError }
  | { kind: "retry"; key: string; retry: Retry };
export type Row =
  | { kind: "user"; key: string; message: Extract<Message, { type: "user" }>; sending: boolean }
  | { kind: "turn"; key: string; items: readonly Item[] }
  | { kind: "notice"; key: string; message: Message }
  | { kind: "failure"; key: string; error: StructuredError };

export const editTools: readonly string[] = ["edit", "write", "patch"];
/** A finished call with nothing more to say than that it happened. */
const folds = (part: ToolPart) => part.state.status === "completed" && part.name !== subagentTool && !editTools.includes(part.name);

function turnItems(messages: readonly Assistant[], running: boolean, last: boolean): Item[] {
  const items: Item[] = [];
  let run: ToolPart[] = [];
  const close = () => {
    if (run.length === 1) items.push({ kind: "tool", key: run[0]!.id, part: run[0]! });
    else if (run.length) items.push({ kind: "tools", key: `run:${run[0]!.id}`, parts: run });
    run = [];
  };
  for (const [index, message] of messages.entries()) {
    const open = running && last && index === messages.length - 1 && !message.time.completed;
    let texts = 0;
    for (const [position, part] of message.content.entries()) {
      if (part.type === "reasoning") continue;
      if (part.type === "text") {
        const ordinal = texts++;
        if (!part.text.trim()) continue;
        close();
        items.push({ kind: "text", key: `${message.id}:text:${ordinal}`, text: part.text, live: open && position === message.content.length - 1 });
      } else if (folds(part)) run.push(part);
      else {
        close();
        items.push(part.name === subagentTool ? { kind: "subagent", key: part.id, messageID: message.id, part } : { kind: "tool", key: part.id, part });
      }
    }
    if (message.retry && !message.time.completed) { close(); items.push({ kind: "retry", key: `${message.id}:retry`, retry: message.retry }); }
    // A step the user stopped is said once, by the run's end ("Stopped").
    else if (message.error && message.error.type !== "aborted") { close(); items.push({ kind: "error", key: `${message.id}:error`, error: message.error }); }
  }
  close();
  return items;
}

export function layout(session: SessionState): Row[] {
  const rows: Row[] = [];
  const running = session.status === "running";
  let turn: Assistant[] = [];
  const close = (last: boolean) => {
    if (!turn.length) return;
    const items = turnItems(turn, running, last);
    if (items.length) rows.push({ kind: "turn", key: `turn:${turn[0]!.id}`, items });
    turn = [];
  };
  for (const id of session.order) {
    const message = session.messages[id];
    if (!message) continue;
    if (message.type === "assistant") { turn.push(message); continue; }
    if (message.type === "user") {
      const status = pendingStatus(session, id);
      // A prompt waiting behind the run is shown in the queue above the composer.
      if (status && status !== "sending" && status !== "starting") continue;
      close(false);
      rows.push({ kind: "user", key: id, message, sending: status === "sending" });
      continue;
    }
    // A finished run leaves nothing to say; reports of a system kind are not conversation.
    if (message.type === "idle" && message.outcome === "succeeded") { close(false); continue; }
    if (message.type === "system") continue;
    close(false);
    rows.push({ kind: "notice", key: id, message });
  }
  close(true);
  const failure = session.failure;
  if (failure) {
    const shown = rows.findLast(row => row.kind === "turn")?.items.some(item => item.kind === "error" && item.error.message === failure.message);
    if (!shown) rows.push({ kind: "failure", key: "failure", error: failure });
  }
  return rows;
}

const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
  return false;
};
function keep<A extends { key: string }>(previous: ReadonlyMap<string, A>, next: A): A {
  const old = previous.get(next.key);
  if (!old) return next;
  const keys = Object.keys(next) as (keyof A)[];
  return keys.length === Object.keys(old).length && keys.every(key => same(old[key], next[key])) ? old : next;
}
/** The new rows, with every row and item that did not change replaced by the object of
 * the previous layout: a memoised component then skips it. */
export function reconcile(previous: readonly Row[], next: Row[]): Row[] {
  const rows = new Map(previous.map(row => [row.key, row] as const));
  return next.map(row => {
    const old = rows.get(row.key);
    if (row.kind === "turn" && old?.kind === "turn") {
      const items = new Map(old.items.map(item => [item.key, item] as const));
      row = { ...row, items: row.items.map(item => keep(items, item)) };
    }
    return keep(rows, row);
  });
}
