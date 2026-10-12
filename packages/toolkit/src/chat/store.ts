// The chat's state and the store that holds it.
//
// The state is normalised and immutable: a change replaces only the objects on the path to
// what changed. A text delta of one message replaces that message, its session's `messages`
// map, the session and the root; every other message keeps its identity. That is what
// makes subscriptions fine-grained: `select(state => state.sessions[s]?.messages[m], …)`
// (or the same selector under React's `useSyncExternalStore`) fires only for that message.
import type {
  FormInfo, ModelInfo, ModelRef, PermissionRequest, SessionInboxInfo, SessionInfo, SessionMessageInfo,
} from '@opencode/client';
import type { ConnectionState } from './connection';

export type Message = SessionMessageInfo;
export type AssistantMessage = Extract<Message, { type: 'assistant' }>;
export type MessagePart = AssistantMessage['content'][number];
export type ToolPart = Extract<MessagePart, { type: 'tool' }>;
export type StructuredError = NonNullable<AssistantMessage['error']>;

/** Everything known about one session: a root conversation, or the child session of a
 * subagent (`parentID`). Children have exactly the same shape as roots. */
export interface SessionState {
  readonly id: string;
  /** Absent until the session has been read or seen created. */
  readonly info?: SessionInfo;
  readonly parentID?: string;
  /** `unknown` until the server's list of running sessions has been read on this connection. */
  readonly status: 'idle' | 'running' | 'unknown';
  /** Message ids, oldest first. Pending prompts are in it too, at the end (see `pending`). */
  readonly order: readonly string[];
  readonly messages: Readonly<Record<string, Message>>;
  /** Prompts (and compactions) the server has admitted but not delivered to the run yet.
   * A user or synthetic item is also a message of the same id in `order`. */
  readonly pending: readonly SessionInboxInfo[];
  /** Prompts this client sent that the server has not acknowledged yet. */
  readonly outbox: readonly string[];
  /** Kept live from the event stream for every session, loaded or not. */
  readonly permissions: readonly PermissionRequest[];
  readonly forms: readonly FormInfo[];
  /** The transcript is authoritative: its latest page has been read on this connection, or
   * the session was seen from its creation. Message events are ignored until then. */
  readonly loaded: boolean;
  /** A read of the transcript is in flight. */
  readonly loading: boolean;
  /** Cursor of the next older page; absent at the start of history. */
  readonly older?: string;
  readonly loadingOlder: boolean;
  /** Text and reasoning parts whose beginning this client did not receive (it joined
   * mid-stream; deltas are not stored by the server): `<messageID>:<text|reasoning>:<n>`,
   * n counting parts of that kind in the message. Cleared when the part ends. */
  readonly partial: readonly string[];
  /** An event could not be applied (unknown message or tool, a gap in the sequence, a run
   * that ended with unfinished tools): the transcript is read again. */
  readonly stale: boolean;
  /** Sequence number of the last durable event applied on this connection. */
  readonly seq?: number;
  /** The failure of the last run, until the next run starts. */
  readonly failure?: StructuredError;
  /** Counts of text and reasoning parts a message had when its step was started again
   * under the same id (a retry): part ordinals of the new attempt count from there. */
  readonly bases: Readonly<Record<string, { readonly text: number; readonly reasoning: number }>>;
}

export interface ChatState {
  readonly connection: ConnectionState;
  /** Every session this client knows, roots and subagent children alike, by id. Forms that
   * belong to no session (MCP elicitations) are under the id `global`. */
  readonly sessions: Readonly<Record<string, SessionState>>;
  /** The conversation on screen. */
  readonly sessionID?: string;
  readonly models: readonly ModelInfo[];
  /** Resolved location default; does not mutate the session's model selection. */
  readonly defaultModel?: ModelRef;
  /** The session list and model catalog have been read on this connection. */
  readonly ready: boolean;
  /** Controller-local logical conversation identity, including an uncreated new chat. */
  readonly draftKey?: string;
  /** Session creation or selection has not completed. */
  readonly sessionOperationPending: boolean;
  /** Reason given to an active hold(). */
  readonly held?: string;
  /** Prompt requests in flight. */
  readonly sending: number;
  /** Sessions an interrupt was requested for and that have not stopped yet. */
  readonly interrupting: readonly string[];
  /** Requests being answered, and the last failure of an answer, by request id. */
  readonly replies: Readonly<Record<string, { readonly submitting: boolean; readonly error?: string }>>;
  readonly error?: string;
}

export const emptySession = (id: string): SessionState => ({
  id, status: 'unknown', order: [], messages: {}, pending: [], outbox: [], permissions: [], forms: [],
  loaded: false, loading: false, loadingOlder: false, partial: [], stale: false, bases: {},
});

export const initialState = (sessionID?: string): ChatState => ({
  connection: { status: 'stopped', attempt: 0 }, sessions: {}, sessionID, models: [], ready: false,
  draftKey: sessionID ? `session:${sessionID}` : undefined, sessionOperationPending: false, sending: 0,
  interrupting: [], replies: {},
});

export interface ReadonlyStore<S> {
  get(): S;
  /** Every change. */
  subscribe(listener: () => void): () => void;
  /** Only when the selected value changes (`Object.is`, or `equal`). */
  select<A>(selector: (state: S) => A, listener: (value: A, previous: A) => void, equal?: (a: A, b: A) => boolean): () => void;
}
export interface Store<S> extends ReadonlyStore<S> {
  set(next: S): void;
  update(change: (state: S) => S): void;
  /** Changes made inside notify once, at the end. */
  batch<A>(work: () => A): A;
  /** Drops every listener; later changes notify nobody. */
  close(): void;
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial, depth = 0, dirty = false, closed = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    if (depth) { dirty = true; return; }
    dirty = false;
    for (const listener of [...listeners]) listener();
  };
  const store: Store<S> = {
    get: () => state,
    set(next) {
      if (closed || Object.is(next, state)) return;
      state = next;
      notify();
    },
    update(change) { store.set(change(state)); },
    batch(work) {
      depth++;
      try { return work(); }
      finally { if (--depth === 0 && dirty) notify(); }
    },
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    select(selector, listener, equal = Object.is) {
      let current = selector(state);
      return store.subscribe(() => {
        const next = selector(state);
        if (equal(next, current)) return;
        const previous = current;
        current = next;
        listener(next, previous);
      });
    },
    close() { closed = true; listeners.clear(); },
  };
  return store;
}
