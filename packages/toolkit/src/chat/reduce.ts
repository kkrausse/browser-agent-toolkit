// Server events folded into the chat state: `reduce(state, event) => state`, pure.
//
// Ported from OpenCode 2.0.26, the event handler of `packages/client/src/solid/data.ts`
// (MIT, see ../../NOTICES.md), which mirrors the server's own projection
// (`packages/core/src/session/message-updater.ts`). Rewritten from Solid store mutations
// to immutable updates that replace only what changed (see ./store.ts), with three
// additions of this client:
//
// - Parts are addressed by key, so applying an event twice is harmless: a tool by its
//   id, a text or reasoning part by the `ordinal` its events carry. That is what lets a
//   transcript read be followed by a replay of the events that arrived during it
//   (`applySnapshot`), where upstream drops or misapplies them until the next read.
// - What cannot be applied marks the session `stale` instead of being dropped silently;
//   the owner reads the transcript again (./sync.ts).
//
// Durable events carry `durable: { aggregateID, seq }`. The numbers are not used here: the
// stream leaves some out (a session's sequence as received from a 2.0.26 server went
// 6, 8: an event the server keeps to itself), so a jump does not mean a loss. Deltas are
// ephemeral and are not stored by the server; every `*.ended` event carries the full text and replaces what the
// deltas accumulated.
import type {
  FormInfo, OpenCodeEvent, PermissionRequest, SessionInboxInfo, SessionInfo,
} from '@opencode/client';
import { emptySession, type AssistantMessage, type ChatState, type Message, type MessagePart, type SessionState, type ToolPart } from './store';

type EventOf<Type extends OpenCodeEvent['type']> = Extract<OpenCodeEvent, { type: Type }>;
type TextPart = Extract<MessagePart, { type: 'text' }>;
type ReasoningPart = Extract<MessagePart, { type: 'reasoning' }>;

const messageIDFromEvent = (eventID: string) => eventID.replace(/^evt_/, 'msg_');

/** The session an event belongs to; undefined for events of the location or the server. */
export function eventSession(event: OpenCodeEvent): string | undefined {
  if (event.type === 'form.created') return event.data.form.sessionID;
  const data = (event as { data?: { sessionID?: unknown } }).data;
  return data && typeof data.sessionID === 'string' ? data.sessionID : undefined;
}

export function reduce(state: ChatState, event: OpenCodeEvent): ChatState {
  const id = eventSession(event);
  if (!id) return state;
  if (event.type === 'session.deleted') {
    if (!state.sessions[id]) return state;
    const { [id]: _removed, ...sessions } = state.sessions;
    return { ...state, sessions };
  }
  const known = state.sessions[id];
  const before = known ?? emptySession(id);
  const after = reduceSession(before, event);
  return after === before ? state : { ...state, sessions: { ...state.sessions, [id]: after } };
}

// ---- immutable edits -------------------------------------------------------

const stale = (session: SessionState): SessionState => session.stale ? session : { ...session, stale: true };

function append(session: SessionState, message: Message): SessionState {
  if (session.messages[message.id]) return session;
  return { ...session, order: [...session.order, message.id], messages: { ...session.messages, [message.id]: message } };
}
function put(session: SessionState, message: Message): SessionState {
  if (!session.messages[message.id]) return append(session, message);
  return { ...session, messages: { ...session.messages, [message.id]: message } };
}
function remove(session: SessionState, id: string): SessionState {
  if (!session.messages[id]) return session;
  const { [id]: _removed, ...messages } = session.messages;
  return { ...session, order: session.order.filter(item => item !== id), messages };
}
/** Streaming events target one assistant message. A missing target means this client's
 * transcript is behind the server's. */
function editAssistant(session: SessionState, id: string, edit: (assistant: AssistantMessage) => AssistantMessage | undefined): SessionState {
  const message = session.messages[id];
  if (message?.type !== 'assistant') return stale(session);
  const next = edit(message);
  if (!next) return stale(session);
  return next === message ? session : { ...session, messages: { ...session.messages, [id]: next } };
}
function editPart(assistant: AssistantMessage, index: number, part: MessagePart): AssistantMessage {
  if (assistant.content[index] === part) return assistant;
  const content = assistant.content.slice();
  content[index] = part;
  return { ...assistant, content };
}
function editTool(session: SessionState, messageID: string, toolID: string, edit: (tool: ToolPart) => ToolPart): SessionState {
  return editAssistant(session, messageID, assistant => {
    const index = assistant.content.findLastIndex(part => part.type === 'tool' && part.id === toolID);
    if (index < 0) return undefined;
    return editPart(assistant, index, edit(assistant.content[index] as ToolPart));
  });
}
/** Index in `content` of the part an ordinal names: the n-th of its kind, counted from
 * where the step's current attempt began. */
function partIndex(session: SessionState, assistant: AssistantMessage, kind: 'text' | 'reasoning', ordinal: number): number {
  let wanted = ordinal + (session.bases[assistant.id]?.[kind] ?? 0);
  for (let index = 0; index < assistant.content.length; index++)
    if (assistant.content[index]!.type === kind && wanted-- === 0) return index;
  return -1;
}
const countParts = (assistant: AssistantMessage, kind: 'text' | 'reasoning') =>
  assistant.content.reduce((count, part) => count + (part.type === kind ? 1 : 0), 0);
const partialKey = (messageID: string, kind: 'text' | 'reasoning', ordinal: number) => `${messageID}:${kind}:${ordinal}`;
function clearPartial(session: SessionState, key: string): SessionState {
  return session.partial.includes(key) ? { ...session, partial: session.partial.filter(item => item !== key) } : session;
}
/** A step that ended has no open parts. */
function settled(session: SessionState, messageID: string): SessionState {
  const prefix = `${messageID}:`;
  return session.partial.some(key => key.startsWith(prefix)) ? { ...session, partial: session.partial.filter(key => !key.startsWith(prefix)) } : session;
}
const withInfo = (session: SessionState, patch: Partial<SessionInfo>): SessionState =>
  session.info ? { ...session, info: { ...session.info, ...patch } } : session;
const activeAssistant = (session: SessionState): AssistantMessage | undefined => {
  for (let index = session.order.length - 1; index >= 0; index--) {
    const message = session.messages[session.order[index]!];
    if (message?.type === 'assistant' && !message.time.completed) return message;
  }
  return undefined;
};
function findLast<M extends Message>(session: SessionState, match: (message: Message) => message is M): M | undefined {
  for (let index = session.order.length - 1; index >= 0; index--) {
    const message = session.messages[session.order[index]!];
    if (message && match(message)) return message;
  }
  return undefined;
}
export const hasUnfinishedTools = (session: SessionState): boolean => session.order.some(id => {
  const message = session.messages[id];
  return message?.type === 'assistant' && message.content.some(part =>
    part.type === 'tool' && (part.state.status === 'streaming' || part.state.status === 'running'));
});

// ---- inbox -----------------------------------------------------------------

/** A pending user or synthetic prompt is also a transcript row of the same id. */
function materialize(session: SessionState, item: SessionInboxInfo): SessionState {
  if (item.type !== 'user' && item.type !== 'synthetic') return session;
  const row: Message = item.type === 'user'
    ? { id: item.id, type: 'user', ...item.payload, time: { created: item.time.created } }
    : { id: item.id, type: 'synthetic', ...item.payload, time: { created: item.time.created } };
  return put(session, row);
}
/** Upsert an admitted inbox item into pending and the visible transcript. */
export function admit(session: SessionState, item: SessionInboxInfo): SessionState {
  const at = session.pending.findIndex(entry => entry.id === item.id);
  const pending = at < 0 ? [...session.pending, item] : session.pending.map((entry, index) => index === at ? item : entry);
  return materialize({ ...session, pending }, item);
}
/** Remove an inbox item from pending and from the transcript. */
export function retract(session: SessionState, inboxID: string): SessionState {
  const pending = session.pending.some(item => item.id === inboxID) ? session.pending.filter(item => item.id !== inboxID) : session.pending;
  const outbox = session.outbox.includes(inboxID) ? session.outbox.filter(id => id !== inboxID) : session.outbox;
  return remove(pending === session.pending && outbox === session.outbox ? session : { ...session, pending, outbox }, inboxID);
}
const removePending = (session: SessionState, inboxID?: string): SessionState =>
  inboxID && session.pending.some(item => item.id === inboxID) ? { ...session, pending: session.pending.filter(item => item.id !== inboxID) } : session;

// ---- one session -----------------------------------------------------------

export function reduceSession(input: SessionState, event: OpenCodeEvent): SessionState {
  const session = reduceAlways(input, event);
  return session.loaded ? reduceTranscript(session, event) : session;
}

/** What is kept for every session, whether its transcript is loaded or not. */
function reduceAlways(session: SessionState, event: OpenCodeEvent): SessionState {
  switch (event.type) {
    case 'session.created': {
      const data = event.data;
      // A session seen from its creation starts empty: the events are its whole transcript.
      const info: SessionInfo = session.info ?? {
        id: data.sessionID, parentID: data.parentID, projectID: data.projectID, agent: data.agent, model: data.model,
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: event.created, updated: event.created }, title: data.title, subpath: data.subpath,
        location: { directory: data.location.directory },
      };
      return { ...session, info, parentID: data.parentID ?? session.parentID, status: session.status === 'unknown' ? 'idle' : session.status, loaded: true };
    }
    case 'session.execution.started':
      return session.status === 'running' && !session.failure ? session : { ...session, status: 'running', failure: undefined };
    case 'session.execution.succeeded':
    case 'session.execution.interrupted':
      return session.status === 'idle' ? session : { ...session, status: 'idle' };
    case 'session.execution.failed':
      return { ...session, status: 'idle', failure: event.data.error };
    case 'session.usage.updated':
      return withInfo(session, { cost: event.data.cost, tokens: event.data.tokens });
    case 'session.renamed':
      return withInfo(session, { title: event.data.title });
    case 'session.agent.selected':
      return withInfo(session, { agent: event.data.agent });
    case 'session.model.selected':
      return withInfo(session, { model: event.data.model });
    case 'session.permissions':
      return withInfo(session, { permissions: event.data.permissions });
    case 'session.moved':
      return withInfo(session, {
        location: { directory: event.data.location.directory },
        ...(event.data.projectID ? { projectID: event.data.projectID } : {}), subpath: event.data.subpath,
      });
    case 'session.revert.staged':
      return withInfo(session, { revert: event.data.revert });
    case 'session.revert.cleared':
      return withInfo(session, { revert: undefined });
    case 'permission.asked':
      if (session.permissions.some(request => request.id === event.data.id)) return session;
      return { ...session, permissions: [...session.permissions, event.data as PermissionRequest] };
    case 'permission.replied':
      if (!session.permissions.some(request => request.id === event.data.requestID)) return session;
      return { ...session, permissions: session.permissions.filter(request => request.id !== event.data.requestID) };
    case 'form.created':
      if (session.forms.some(form => form.id === event.data.form.id)) return session;
      return { ...session, forms: [...session.forms, event.data.form as FormInfo] };
    case 'form.replied':
    case 'form.cancelled':
      if (!session.forms.some(form => form.id === event.data.id)) return session;
      return { ...session, forms: session.forms.filter(form => form.id !== event.data.id) };
    default:
      return session;
  }
}

function reduceTranscript(session: SessionState, event: OpenCodeEvent): SessionState {
  switch (event.type) {
    case 'session.agent.selected': {
      const previous = findLast(session, (message): message is Extract<Message, { type: 'agent-switched' }> => message.type === 'agent-switched')?.agent;
      return append(session, { id: messageIDFromEvent(event.id), type: 'agent-switched', agent: event.data.agent, previous, time: { created: event.created } });
    }
    case 'session.model.selected':
      return append(session, { id: messageIDFromEvent(event.id), type: 'model-switched', model: event.data.model, time: { created: event.created } });
    case 'session.moved':
      return append(session, {
        id: messageIDFromEvent(event.id), type: 'location-switched', location: { directory: event.data.location.directory },
        projectID: event.data.projectID, subpath: event.data.subpath, time: { created: event.created },
      } as Message);
    case 'session.inbox.enqueued': {
      const item = { id: event.data.inboxID, sessionID: event.data.sessionID, time: { created: event.created }, ...event.data.item } as SessionInboxInfo;
      const acknowledged = session.outbox.includes(item.id) ? { ...session, outbox: session.outbox.filter(id => id !== item.id) } : session;
      return admit(acknowledged, item);
    }
    case 'session.inbox.delivery.changed': {
      const at = session.pending.findIndex(item => item.id === event.data.inboxID);
      const item = session.pending[at];
      if (!item || item.delivery === event.data.delivery) return session;
      return { ...session, pending: session.pending.map((entry, index) => index === at ? { ...entry, delivery: event.data.delivery } as SessionInboxInfo : entry) };
    }
    case 'session.inbox.cancelled':
      return retract(session, event.data.inboxID);
    case 'session.inbox.delivered': {
      const id = event.data.inboxID;
      const admitted = session.pending.some(item => item.id === id && item.type !== 'compaction');
      const next = removePending(session, id);
      const existing = next.messages[id];
      // The prompt joins the run here: its row moves below everything delivered before it.
      if (!existing || !admitted) return next;
      return {
        ...next, order: [...next.order.filter(item => item !== id), id],
        messages: { ...next.messages, [id]: { ...existing, time: { ...existing.time, created: event.created } } as Message },
      };
    }
    case 'session.instructions.updated':
      // The initial baseline and empty-rendering deltas carry no text and produce no message.
      if (event.data.text === undefined) return session;
      return append(session, {
        id: messageIDFromEvent(event.id), type: 'system', text: event.data.text,
        description: `Instructions updated: ${Object.keys(event.data.delta).join(', ')}`, metadata: event.metadata, time: { created: event.created },
      });
    case 'session.synthetic':
      return append(session, {
        id: messageIDFromEvent(event.id), type: 'synthetic', text: event.data.text, description: event.data.description,
        metadata: event.data.metadata, time: { created: event.created },
      });
    case 'session.shell.started':
      return append(session, {
        id: messageIDFromEvent(event.id), type: 'shell', shellID: event.data.shell.id, command: event.data.shell.command,
        status: event.data.shell.status, exit: event.data.shell.exit,
        metadata: event.data.shell.metadata.background === true ? { ...event.metadata, background: true } : event.metadata,
        time: { created: event.created },
      });
    case 'session.shell.ended': {
      const match = findLast(session, (message): message is Extract<Message, { type: 'shell' }> => message.type === 'shell' && message.shellID === event.data.shell.id);
      if (!match) return stale(session);
      return put(session, { ...match, status: event.data.shell.status, exit: event.data.shell.exit, output: event.data.output, time: { ...match.time, completed: event.created } });
    }
    case 'session.step.started': {
      const existing = session.messages[event.data.assistantMessageID];
      if (existing?.type === 'assistant') {
        // The same step attempted again (a retry): its parts stay, and the ordinals of the
        // new attempt count from here.
        const base = { text: countParts(existing, 'text'), reasoning: countParts(existing, 'reasoning') };
        const bases = base.text || base.reasoning ? { ...session.bases, [existing.id]: base } : session.bases;
        return put({ ...session, bases }, {
          ...existing, agent: event.data.agent, model: event.data.model, retry: undefined, error: undefined, finish: undefined,
          rawFinish: undefined, providerState: undefined,
          time: { created: event.data.started },
          snapshot: event.data.snapshot ? { ...existing.snapshot, start: event.data.snapshot } : existing.snapshot,
        });
      }
      const current = activeAssistant(session);
      const closed = current ? put(session, { ...current, retry: undefined, time: { ...current.time, completed: event.created } }) : session;
      return append(closed, {
        id: event.data.assistantMessageID, type: 'assistant', agent: event.data.agent, model: event.data.model, metadata: event.metadata,
        content: [], snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined, time: { created: event.data.started },
      });
    }
    case 'session.step.streamed':
      return editAssistant(session, event.data.assistantMessageID, assistant =>
        assistant.time.streamed === event.created ? assistant : { ...assistant, time: { ...assistant.time, streamed: event.created } });
    case 'session.step.ended':
      return editAssistant(settled(session, event.data.assistantMessageID), event.data.assistantMessageID, assistant => ({
        ...assistant, time: { ...assistant.time, completed: event.created }, finish: event.data.finish, rawFinish: event.data.rawFinish,
        providerState: event.data.providerState, cost: event.data.cost, tokens: event.data.tokens,
        snapshot: event.data.snapshot ? { ...assistant.snapshot, end: event.data.snapshot } : assistant.snapshot,
      }));
    case 'session.step.failed':
      return editAssistant(settled(session, event.data.assistantMessageID), event.data.assistantMessageID, assistant => ({
        ...assistant, time: { ...assistant.time, completed: event.created }, finish: event.data.finish ?? 'error', rawFinish: event.data.rawFinish,
        providerState: event.data.providerState, error: event.data.error, retry: undefined,
        ...(event.data.cost !== undefined && event.data.tokens !== undefined ? { cost: event.data.cost, tokens: event.data.tokens } : {}),
      }));
    case 'session.retry.scheduled':
      return editAssistant(session, event.data.assistantMessageID, assistant =>
        ({ ...assistant, retry: { attempt: event.data.attempt, at: event.data.at, error: event.data.error } }));
    case 'session.text.started':
    case 'session.reasoning.started': {
      const kind = event.type === 'session.text.started' ? 'text' : 'reasoning';
      return editAssistant(session, event.data.assistantMessageID, assistant => {
        // Already there: the transcript read included this start.
        if (partIndex(session, assistant, kind, event.data.ordinal) >= 0) return assistant;
        const part: MessagePart = event.type === 'session.text.started'
          ? { type: 'text', text: '' }
          : { type: 'reasoning', text: '', state: event.data.state, time: { created: event.created } };
        return { ...assistant, content: [...assistant.content, part] };
      });
    }
    case 'session.text.delta':
    case 'session.reasoning.delta': {
      const kind = event.type === 'session.text.delta' ? 'text' : 'reasoning';
      return editAssistant(session, event.data.assistantMessageID, assistant => {
        const index = partIndex(session, assistant, kind, event.data.ordinal);
        if (index < 0) return undefined;
        const part = assistant.content[index] as TextPart | ReasoningPart;
        return editPart(assistant, index, { ...part, text: part.text + event.data.delta });
      });
    }
    case 'session.text.ended': {
      const next = editAssistant(session, event.data.assistantMessageID, assistant => {
        const index = partIndex(session, assistant, 'text', event.data.ordinal);
        if (index < 0) return undefined;
        const part = assistant.content[index] as TextPart;
        return editPart(assistant, index, { ...part, text: event.data.text, ...(event.data.state !== undefined ? { state: event.data.state } : {}) });
      });
      return clearPartial(next, partialKey(event.data.assistantMessageID, 'text', event.data.ordinal));
    }
    case 'session.reasoning.ended': {
      const next = editAssistant(session, event.data.assistantMessageID, assistant => {
        const index = partIndex(session, assistant, 'reasoning', event.data.ordinal);
        if (index < 0) return undefined;
        const part = assistant.content[index] as ReasoningPart;
        return editPart(assistant, index, {
          ...part, text: event.data.text, time: { created: part.time?.created ?? event.created, completed: event.created },
          ...(event.data.state !== undefined ? { state: event.data.state } : {}),
        });
      });
      return clearPartial(next, partialKey(event.data.assistantMessageID, 'reasoning', event.data.ordinal));
    }
    case 'session.tool.input.started':
      return editAssistant(session, event.data.assistantMessageID, assistant => {
        if (assistant.content.some(part => part.type === 'tool' && part.id === event.data.id)) return assistant;
        return { ...assistant, content: [...assistant.content, { type: 'tool', id: event.data.id, name: event.data.name, time: { created: event.created }, state: { status: 'streaming', input: '' } }] };
      });
    case 'session.tool.input.delta':
      return editTool(session, event.data.assistantMessageID, event.data.id, tool =>
        tool.state.status === 'streaming' ? { ...tool, state: { status: 'streaming', input: tool.state.input + event.data.delta } } : tool);
    case 'session.tool.input.ended':
      return editTool(session, event.data.assistantMessageID, event.data.id, tool =>
        tool.state.status === 'streaming' ? { ...tool, state: { status: 'streaming', input: event.data.text } } : tool);
    case 'session.tool.called':
      return editTool(session, event.data.assistantMessageID, event.data.id, tool => ({
        ...tool, time: { ...tool.time, ran: event.created }, executed: event.data.executed, providerState: event.data.state,
        // Progress that arrived before a repeated call keeps its metadata.
        state: { status: 'running', input: event.data.input, metadata: tool.state.status === 'running' ? tool.state.metadata : {} },
      }));
    case 'session.tool.progress':
      return editTool(session, event.data.assistantMessageID, event.data.id, tool =>
        tool.state.status === 'running' ? { ...tool, state: { ...tool.state, metadata: event.data.metadata } } : tool);
    case 'session.tool.success':
      return editTool(session, event.data.assistantMessageID, event.data.id, tool => {
        if (tool.state.status !== 'running') return tool;
        return {
          ...tool, state: { status: 'completed', input: tool.state.input, metadata: event.data.metadata, content: [...event.data.content] as never },
          executed: event.data.executed || tool.executed === true, providerResultState: event.data.resultState, time: { ...tool.time, completed: event.created },
        };
      });
    case 'session.tool.failed':
      return editTool(session, event.data.assistantMessageID, event.data.id, tool => {
        if (tool.state.status !== 'streaming' && tool.state.status !== 'running') return tool;
        return {
          ...tool,
          state: { status: 'error', error: event.data.error, input: typeof tool.state.input === 'string' ? {} : tool.state.input, metadata: event.data.metadata, content: event.data.content as never },
          executed: event.data.executed || tool.executed === true, providerResultState: event.data.resultState, time: { ...tool.time, completed: event.created },
        };
      });
    case 'session.compaction.started': {
      const next = removePending(session, event.data.inputID);
      return append(next, {
        id: event.data.inputID ?? messageIDFromEvent(event.id), type: 'compaction', status: 'running', reason: event.data.reason,
        summary: '', recent: event.data.recent ?? '', time: { created: event.created },
      });
    }
    case 'session.compaction.delta': {
      const current = findLast(session, (message): message is Extract<Message, { type: 'compaction'; status: 'running' }> => message.type === 'compaction' && message.status === 'running');
      return current ? put(session, { ...current, summary: current.summary + event.data.text }) : stale(session);
    }
    case 'session.compaction.ended': {
      const current = findLast(session, (message): message is Extract<Message, { type: 'compaction'; status: 'running' }> => message.type === 'compaction' && message.status === 'running');
      const completed = {
        type: 'compaction' as const, status: 'completed' as const, reason: event.data.reason, model: event.data.model, providerState: event.data.providerState,
        providerContext: event.data.providerContext, summary: event.data.text, recent: event.data.recent, cost: event.data.cost, tokens: event.data.tokens,
      };
      if (current) return put(session, { id: current.id, metadata: current.metadata, time: current.time, ...completed } as Message);
      return append(session, { id: messageIDFromEvent(event.id), time: { created: event.created }, ...completed } as Message);
    }
    case 'session.compaction.failed': {
      const next = removePending(session, event.data.inputID);
      const current = findLast(next, (message): message is Extract<Message, { type: 'compaction'; status: 'running' }> => message.type === 'compaction' && message.status === 'running');
      return put(next, {
        id: current?.id ?? event.data.inputID ?? messageIDFromEvent(event.id), type: 'compaction', status: 'failed', reason: event.data.reason ?? 'manual',
        error: event.data.error ?? { type: 'compaction.failed', message: 'Compaction failed before recording an error' },
        metadata: current ? current.metadata : event.metadata, cost: event.data.cost, tokens: event.data.tokens,
        time: current ? current.time : { created: event.created },
      } as Message);
    }
    case 'session.execution.succeeded':
    case 'session.execution.failed':
    case 'session.execution.interrupted': {
      const current = activeAssistant(session);
      let next = current?.retry ? put(session, { ...current, retry: undefined }) : session;
      // A run the server shut down under ends without a marker; the next start resumes it.
      if (event.type === 'session.execution.interrupted' && event.data.reason === 'shutdown') return next;
      // Mirror the projected idle marker so turn boundaries match before the next read.
      next = append(next, {
        id: messageIDFromEvent(event.id), type: 'idle', time: { created: event.created },
        outcome: event.type === 'session.execution.succeeded' ? 'succeeded' : event.type === 'session.execution.failed' ? 'failed' : 'interrupted',
      });
      // Tools the run left unfinished were settled by the server without an event of their own.
      return hasUnfinishedTools(next) ? stale(next) : next;
    }
    case 'session.revert.committed': {
      // The projector also deletes inbox items enqueued at or after the boundary without a cancel event.
      const pending = session.pending.filter(item => item.id < event.data.to);
      const cut = session.order.findIndex(id => id >= event.data.to);
      if (cut < 0) return pending.length === session.pending.length ? withInfo(session, { revert: undefined }) : withInfo({ ...session, pending }, { revert: undefined });
      const messages = { ...session.messages };
      for (const id of session.order.slice(cut)) delete messages[id];
      return withInfo({ ...session, pending, order: session.order.slice(0, cut), messages }, { revert: undefined });
    }
    default:
      return session;
  }
}

// ---- reading a transcript --------------------------------------------------

export interface TranscriptSnapshot {
  /** The latest page, oldest first. */
  messages: readonly Message[];
  /** Cursor of the page before it. */
  older?: string;
  /** Read before `messages`, so every item absent from it and from the page was either
   * admitted after it or is in the page. */
  pending: readonly SessionInboxInfo[];
  permissions: readonly PermissionRequest[];
  forms: readonly FormInfo[];
}

/**
 * Commit a transcript read, then apply the events that arrived while it was in flight.
 *
 * The read reflects every event up to some point during the request; which point is not
 * known (the API returns no sequence number). So the events since the request began are
 * applied again on top of it. The ones the read already included change nothing or are
 * overwritten by their successors, because every step of the fold is keyed and the
 * events after them are replayed too; the ones it did not include bring it up to date.
 *
 * Streamed text is the one thing a read cannot supply: the server stores a text part
 * empty until it ends. What this client had already received of an unfinished part is
 * kept; an unfinished part it had never seen start is marked `partial`.
 */
export function applySnapshot(session: SessionState, snapshot: TranscriptSnapshot, during: readonly OpenCodeEvent[]): SessionState {
  const fetched = new Set(snapshot.messages.map(message => message.id));
  // Older pages already loaded stay when the page joins them; otherwise there may be a
  // hole between the two and the page starts the transcript over.
  const joins = session.loaded && session.order.some(id => fetched.has(id));
  const first = snapshot.messages[0]?.id;
  const firstAt = first === undefined ? -1 : session.order.indexOf(first);
  const prefix = joins ? session.order.slice(0, firstAt < 0 ? 0 : firstAt).filter(id => !fetched.has(id)) : [];
  // A prompt this client sent and the server has not acknowledged survives the read.
  const unacknowledged = session.pending.filter(item => session.outbox.includes(item.id) && !fetched.has(item.id) && !snapshot.pending.some(other => other.id === item.id));
  // Delivered prompts are in the page; whatever the inbox still listed of them was read earlier.
  const pending = [...snapshot.pending.filter(item => !fetched.has(item.id)), ...unacknowledged];

  const partial = new Set<string>();
  const messages: Record<string, Message> = {};
  for (const id of prefix) messages[id] = session.messages[id]!;
  for (const message of snapshot.messages) messages[message.id] = mergeStreamed(message, session.messages[message.id], session, partial);
  let next: SessionState = {
    ...session, order: [...prefix, ...snapshot.messages.map(message => message.id)], messages, pending,
    outbox: session.outbox.filter(id => unacknowledged.some(item => item.id === id)),
    permissions: [...snapshot.permissions], forms: [...snapshot.forms],
    older: joins && prefix.length ? session.older : snapshot.older,
    loaded: true, loading: false, stale: false, partial: [...partial],
    bases: Object.fromEntries(Object.entries(session.bases).filter(([id]) => fetched.has(id))),
  };
  for (const item of pending) next = materialize(next, item);
  for (const event of during) next = reduceSession(next, event);
  return next;
}

function mergeStreamed(read: Message, shown: Message | undefined, session: SessionState, partial: Set<string>): Message {
  if (read.type === 'compaction' && read.status === 'running')
    return shown?.type === 'compaction' && shown.status === 'running' && shown.summary.length > read.summary.length ? { ...read, summary: shown.summary } : read;
  if (read.type !== 'assistant' || read.time.completed) return read;
  const live = shown?.type === 'assistant' ? shown : undefined;
  const counts = { text: 0, reasoning: 0 };
  let changed = false;
  const content = read.content.map((part, index) => {
    if (part.type === 'tool') {
      const before = live?.content.find((other): other is ToolPart => other.type === 'tool' && other.id === part.id);
      if (part.state.status === 'streaming' && before?.state.status === 'streaming' && before.state.input.length > part.state.input.length) {
        changed = true;
        return { ...part, state: before.state };
      }
      return part;
    }
    const ordinal = counts[part.type]++;
    // One text part is open at a time, the last; a reasoning part says when it completed.
    if (part.type === 'reasoning' ? part.time?.completed : index !== read.content.length - 1) return part;
    const before = live?.content[index];
    if (before?.type === part.type) {
      if (session.partial.includes(partialKey(read.id, part.type, ordinal))) partial.add(partialKey(read.id, part.type, ordinal));
      if (before.text.length > part.text.length) { changed = true; return { ...part, text: before.text }; }
      return part;
    }
    // An open part this client never saw start: what was streamed before now is gone.
    if (!part.text) partial.add(partialKey(read.id, part.type, ordinal));
    return part;
  });
  return changed ? { ...read, content } : read;
}
