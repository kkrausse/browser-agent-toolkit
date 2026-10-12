// Questions a view asks of the state. All pure; none allocates when its answer is a part of
// the state (so `store.select` and `useSyncExternalStore` see a stable value), and the ones
// that build something say so.
import type { FormInfo, PermissionRequest } from '@opencode/client';
import type { AssistantMessage, ChatState, Message, MessagePart, SessionState, ToolPart } from './store';
import type { PendingPrompt } from './types';

/** The name of the tool that runs an agent in a child session. */
export const subagentTool = 'subagent';

export const messagesOf = (session: SessionState | undefined): Message[] =>
  session ? session.order.flatMap(id => { const message = session.messages[id]; return message ? [message] : []; }) : [];

/** `retrying` while the provider's last answer failed and the step waits to try again. */
export function executionOf(session: SessionState | undefined): 'idle' | 'running' | 'retrying' | 'unknown' {
  if (!session) return 'idle';
  if (session.status !== 'running') return session.status;
  for (let index = session.order.length - 1; index >= 0; index--) {
    const message = session.messages[session.order[index]!];
    if (message?.type === 'assistant') return message.retry && !message.time.completed ? 'retrying' : 'running';
  }
  return 'running';
}

/** The session and every known descendant, parents first. Builds an array. */
export function familyOf(state: ChatState, root: string): string[] {
  const ids = [root];
  for (let index = 0; index < ids.length; index++)
    for (const session of Object.values(state.sessions))
      if (session.parentID === ids[index] && !ids.includes(session.id)) ids.push(session.id);
  return ids;
}

// ---- subagents -------------------------------------------------------------
//
// A subagent run is a call of the `subagent` tool in the parent. The tool creates a child
// session (`session.created` with `parentID`), prompts it, and reports the child's id as
// the call's metadata: `{ sessionID, status: 'running' }` in a `session.tool.progress`
// while it runs, `{ sessionID, status: 'completed' | 'running' }` when the call returns
// (`running` there means it was started, or moved, in the background). The child's own
// events arrive on the same stream under its own session id, and it is a session like any
// other in `state.sessions`. A background run reports back later as a `synthetic` message
// in the parent with `metadata: { source: 'subagent', childID, agent, state }`.

/** The child session a subagent call runs in, once the tool has reported it. */
export function subagentSessionID(part: MessagePart): string | undefined {
  if (part.type !== 'tool' || part.name !== subagentTool) return undefined;
  const metadata = 'metadata' in part.state ? part.state.metadata : undefined;
  const id = metadata?.sessionID;
  return typeof id === 'string' && id ? id : undefined;
}

export interface SubagentCall {
  /** The parent session and the tool call in it. */
  sessionID: string;
  messageID: string;
  toolID: string;
  part: ToolPart;
  /** Absent between the start of the call and the tool's first report. */
  childID?: string;
  /** The child session, when this client knows it. Its `loaded` says whether its
   * transcript is here; `controller.loadSession(childID)` reads it. */
  child?: SessionState;
  agent?: string;
  description?: string;
  /** Started in the background, or moved there: the call returned and the child goes on. */
  background: boolean;
  /** The call is running, or it returned and the child still is. */
  running: boolean;
}

function subagentCall(state: ChatState, sessionID: string, message: AssistantMessage, part: ToolPart): SubagentCall {
  const childID = subagentSessionID(part) ?? matchChild(state, sessionID, part);
  const child = childID ? state.sessions[childID] : undefined;
  const input = typeof part.state.input === 'object' ? part.state.input : parseInput(part.state.input);
  const metadata = 'metadata' in part.state ? part.state.metadata : undefined;
  const background = input?.background === true || (part.state.status === 'completed' && metadata?.status === 'running');
  return {
    sessionID, messageID: message.id, toolID: part.id, part, childID, child,
    agent: typeof input?.agent === 'string' ? input.agent : child?.info?.agent,
    description: typeof input?.description === 'string' ? input.description : child?.info?.title,
    background,
    running: part.state.status === 'streaming' || part.state.status === 'running' || child?.status === 'running',
  };
}
/** Before the tool reports the child's id, the child is the one created under this
 * session with the call's description as its title and no call of its own yet. */
function matchChild(state: ChatState, sessionID: string, part: ToolPart): string | undefined {
  if (part.state.status !== 'running') return undefined;
  const description = part.state.input.description;
  if (typeof description !== 'string') return undefined;
  const session = state.sessions[sessionID];
  const claimed = new Set<string>();
  if (session) for (const id of session.order) {
    const message = session.messages[id];
    if (message?.type === 'assistant') for (const other of message.content) { const child = subagentSessionID(other); if (child) claimed.add(child); }
  }
  let found: SessionState | undefined;
  for (const candidate of Object.values(state.sessions))
    if (candidate.parentID === sessionID && candidate.info?.title === description && !claimed.has(candidate.id)
      && (candidate.info.time.created >= (part.time.ran ?? part.time.created)) && (!found || candidate.info.time.created > found.info!.time.created)) found = candidate;
  return found?.id;
}
function parseInput(text: string): Record<string, unknown> | undefined {
  try { const value: unknown = JSON.parse(text); return value && typeof value === 'object' ? value as Record<string, unknown> : undefined; }
  catch { return undefined; }
}

/** What one subagent tool call is, for the card under it. Builds an object. */
export function subagentOf(state: ChatState, sessionID: string, messageID: string, toolID: string): SubagentCall | undefined {
  const message = state.sessions[sessionID]?.messages[messageID];
  if (message?.type !== 'assistant') return undefined;
  const part = message.content.find((item): item is ToolPart => item.type === 'tool' && item.id === toolID && item.name === subagentTool);
  return part && subagentCall(state, sessionID, message, part);
}
/** Every subagent call of a session's loaded transcript, in order. Builds an array. */
export function subagentCalls(state: ChatState, sessionID: string): SubagentCall[] {
  const session = state.sessions[sessionID];
  if (!session) return [];
  const calls: SubagentCall[] = [];
  for (const id of session.order) {
    const message = session.messages[id];
    if (message?.type !== 'assistant') continue;
    for (const part of message.content) if (part.type === 'tool' && part.name === subagentTool) calls.push(subagentCall(state, sessionID, message, part));
  }
  return calls;
}
/** The tool call that started a child session, if the parent's loaded transcript has it. */
export function spawnedBy(state: ChatState, childID: string): { sessionID: string; messageID: string; toolID: string } | undefined {
  const parentID = state.sessions[childID]?.parentID;
  if (!parentID) return undefined;
  const call = subagentCalls(state, parentID).findLast(item => item.childID === childID);
  return call && { sessionID: call.sessionID, messageID: call.messageID, toolID: call.toolID };
}

/** What a session is doing right now, in one value: for the line under a subagent call. */
export type Activity =
  | { kind: 'permission'; request: PermissionRequest }
  | { kind: 'form'; form: FormInfo }
  | { kind: 'retry'; attempt: number; at: number; message: string }
  | { kind: 'tool'; messageID: string; part: ToolPart }
  | { kind: 'reasoning'; messageID: string; text: string }
  | { kind: 'text'; messageID: string; text: string }
  | { kind: 'working' }
  | { kind: 'failed'; message: string }
  | { kind: 'idle'; outcome?: 'succeeded' | 'failed' | 'interrupted'; text?: string }
  | { kind: 'unknown' };

/** Builds an object. A request waiting for the user comes first: it is what blocks. */
export function activityOf(session: SessionState | undefined): Activity {
  if (!session) return { kind: 'unknown' };
  if (session.permissions[0]) return { kind: 'permission', request: session.permissions[0] };
  if (session.forms[0]) return { kind: 'form', form: session.forms[0] };
  let assistant: AssistantMessage | undefined, outcome: 'succeeded' | 'failed' | 'interrupted' | undefined;
  for (let index = session.order.length - 1; index >= 0 && !assistant; index--) {
    const message = session.messages[session.order[index]!];
    if (message?.type === 'assistant') assistant = message;
    else if (message?.type === 'idle') outcome ??= message.outcome;
  }
  const lastText = assistant?.content.findLast(part => part.type === 'text' && part.text);
  if (session.status !== 'running') {
    if (session.status === 'unknown' && !session.loaded) return { kind: 'unknown' };
    if (session.failure) return { kind: 'failed', message: session.failure.message };
    return { kind: 'idle', outcome, text: lastText?.type === 'text' ? lastText.text : undefined };
  }
  if (!assistant || assistant.time.completed) return { kind: 'working' };
  if (assistant.retry) return { kind: 'retry', attempt: assistant.retry.attempt, at: assistant.retry.at, message: assistant.retry.error.message };
  const tool = assistant.content.findLast((part): part is ToolPart => part.type === 'tool' && (part.state.status === 'running' || part.state.status === 'streaming'));
  if (tool) return { kind: 'tool', messageID: assistant.id, part: tool };
  const last = assistant.content.at(-1);
  if (last?.type === 'reasoning') return { kind: 'reasoning', messageID: assistant.id, text: last.text };
  if (last?.type === 'text') return { kind: 'text', messageID: assistant.id, text: last.text };
  if (last?.type === 'tool') return { kind: 'tool', messageID: assistant.id, part: last };
  return { kind: 'working' };
}

// ---- pending prompts -------------------------------------------------------

/** Where a pending prompt stands relative to the run (OpenCode's `pending.status`). */
export function pendingStatus(session: SessionState, inboxID: string): PendingPrompt['status'] | undefined {
  const item = session.pending.find(entry => entry.id === inboxID && entry.type === 'user');
  if (!item) return undefined;
  if (session.outbox.includes(inboxID)) return 'sending';
  if (item.delivery === 'queue') return 'queued';
  let boundary = -1;
  for (let index = session.order.length - 1; index >= 0 && boundary < 0; index--)
    if (session.messages[session.order[index]!]?.type === 'idle') boundary = index;
  if (session.status !== 'running') {
    const idle = boundary >= 0 ? session.messages[session.order[boundary]!] : undefined;
    return idle && item.time.created <= idle.time.created ? 'stranded' : 'starting';
  }
  // An execution's idle boundary promotes every pending steer at once, so a steer only waits
  // behind work once the current execution has delivered input.
  for (let index = boundary + 1; index < session.order.length; index++) {
    const id = session.order[index]!;
    if (session.messages[id]?.type === 'user' && !session.pending.some(other => other.id === id)) return 'steering';
  }
  return 'starting';
}
/** Builds an array. */
export function pendingPrompts(session: SessionState | undefined): PendingPrompt[] {
  if (!session) return [];
  return session.pending.flatMap(item => item.type === 'user'
    ? [{ id: item.id, sessionID: session.id, text: item.payload.text, delivery: item.delivery, status: pendingStatus(session, item.id) ?? 'starting' }] : []);
}
/** A streaming text or reasoning part whose text here has a piece missing until it ends. */
export const isPartial = (session: SessionState, messageID: string, kind: 'text' | 'reasoning', ordinal: number): boolean =>
  session.partial.includes(`${messageID}:${kind}:${ordinal}`);
