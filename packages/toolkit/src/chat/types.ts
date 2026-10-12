// The chat controller's contract. The server's own shapes (messages, sessions, forms,
// permissions, events) are the official client's, re-exported; nothing is restated here.
import type {
  FormField, FormInfo, ModelInfo, ModelRef, OpenCodeEvent, PermissionRequest, SessionInboxInfo, SessionInfo, SessionMessageInfo,
} from '@opencode/client';
import type { ConnectionState } from './connection';
import type { ChatState, ReadonlyStore, StructuredError } from './store';

export type { FormField, FormInfo, ModelInfo, ModelRef, OpenCodeEvent, PermissionRequest, SessionInboxInfo, SessionInfo, SessionMessageInfo };
export type { ConnectionState, ConnectionStatus } from './connection';
export type { AssistantMessage, ChatState, Message, MessagePart, ReadonlyStore, SessionState, StructuredError, ToolPart } from './store';

/** Legacy public question view, explicitly adapted from question-tool forms. */
export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: { header: string; question: string; options: { label: string; description: string }[]; multiple?: boolean; custom?: boolean }[];
  tool?: { messageID: string; id: string };
}
/** The OpenCode server as the chat reaches it: `path` is what the server sees
 * (`/api/session`). Authorization is the caller's concern (wrap `fetch`). */
export interface ChatEndpoint {
  fetch(path: string, init?: RequestInit): Promise<Response>;
}
/** Where attachments the model cannot take inline are written: the guest's filesystem. */
export interface ChatFiles {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}
export type PermissionDecision = 'once' | 'always' | 'reject';
export type QuestionAnswers = string[][];
/** One value per field key. A field left out is not answered. */
export type FormAnswer = Record<string, string | number | boolean | readonly string[]>;
export type Delivery = 'steer' | 'queue';

/** A file to send with a prompt: bytes this page holds, or a URI the server can already
 * read (`data:`, or `file://` of a path in the guest). */
export type ChatAttachment =
  | { name: string; data: Blob | Uint8Array; mime?: string; description?: string }
  | { uri: string; name?: string; description?: string };

export interface PromptDraft {
  text: string;
  files?: readonly ChatAttachment[];
  /** While the session is running: `steer` (default) joins the run at its next step,
   * `queue` waits until the run and every steer have finished. Idle, both start a run. */
  delivery?: Delivery;
  /** Default: the selected session. */
  sessionID?: string;
}

export interface ChatOptions {
  endpoint: ChatEndpoint;
  directory: string;
  sessionID?: string;
  autoCreateSession?: boolean;
  /** Open on a fresh session at initial connection rather than on the latest history (the
   * latest session itself when it is still empty). */
  startNewSession?: boolean;
  /** Messages per page of history (default 50). */
  pageSize?: number;
  /** How long the first connection may take (the server may still be starting). */
  handshakeTimeoutMs?: number;
  /** The guest filesystem, for attachments sent as files. Without it every attachment is
   * sent inline. */
  files?: ChatFiles;
  /** Directory in the guest that attachments are written under (default
   * `/workspace/.server/tmp/uploads`). */
  uploadDirectory?: string;
  /** Optional observer of timing: connection milestones (`chat.connect` with a `stage`)
   * and one send's timeline (`chat.send.clicked|accepted|rejected`,
   * `chat.reply.first-event|first-text`, joined by `send`). Ids, counts and lengths only:
   * never session titles, messages or prompts. It must not throw. */
  onDiagnostic?(event: string, data?: Record<string, unknown>): void;
  /** Tuning of the event connection; see ./connection.ts. */
  connection?: { idleTimeout?: number; connectTimeout?: number; reconnectDelay?: number; flushInterval?: number; pageLifecycle?: boolean };
}
export type RequestState<T> = {
  request: T;
  submitting: boolean;
  error?: string;
};
/** A prompt the server holds and has not delivered to the run. */
export interface PendingPrompt {
  id: string;
  sessionID: string;
  text: string;
  delivery: Delivery;
  /** `starting`: delivered at the next idle boundary; `steering`: waits for the next step
   * of a run that already took input; `queued`: waits for the run and every steer;
   * `stranded`: outlived a run that ended without taking it; `sending`: not acknowledged yet. */
  status: 'sending' | 'starting' | 'steering' | 'queued' | 'stranded';
}

/**
 * The selected conversation, flattened for a view that renders from one object. It is
 * derived from the store on demand and changes identity on every change of the state:
 * a view that wants to re-render per message subscribes to `controller.store` instead.
 */
export interface ChatSnapshot {
  /** `connecting` covers the first connection and every automatic reconnection;
   * `disconnected` is only reported after `dispose()` or a stop. */
  connection: 'connecting' | 'connected' | 'disconnected';
  connectionState: ConnectionState;
  sessionID?: string;
  /** Root sessions, newest first. Subagent sessions are not listed. */
  sessions: readonly SessionInfo[];
  /** Controller-local logical conversation identity, including an uncreated new chat. */
  draftKey?: string;
  /** Session creation or selection has not completed. */
  sessionOperationPending?: boolean;
  /** Reason given to an active hold(). New sends, session and model changes are rejected. */
  held?: string;
  models: readonly ModelInfo[];
  model?: ModelRef;
  /** Resolved location default; does not mutate the session's model selection. */
  defaultModel?: ModelRef;
  /** Oldest first; pending prompts are among them, at the end. */
  messages: readonly SessionMessageInfo[];
  execution: 'idle' | 'running' | 'retrying' | 'unknown';
  /** The failure of the last run, until the next one starts. */
  failure?: StructuredError;
  interruptRequested: boolean;
  sending: boolean;
  loading: boolean;
  loadingOlder: boolean;
  hasOlder: boolean;
  /** Prompts admitted and not yet delivered (sent while the session was busy). */
  pending: readonly PendingPrompt[];
  /** Of the selected session and of every subagent session below it. */
  permissions: readonly RequestState<PermissionRequest>[];
  /** Every pending form, whatever its fields; answer with `replyForm`. */
  forms: readonly RequestState<FormInfo>[];
  /** The forms among `forms` that have the question tool's shape, in the legacy view. */
  questions: readonly RequestState<QuestionRequest>[];
  /** The forms among `forms` that do not. */
  unsupportedForms: readonly FormInfo[];
  error?: string;
}
/** Exclusive admission lease. release() is idempotent and a no-op after dispose(). */
export interface ChatHold {
  release(): void;
}
export interface ChatController {
  /** The first connection, catalog and session selection. */
  readonly ready: Promise<void>;
  /** The whole state, normalised: every known session (subagent sessions included) with
   * its messages by id. Subscribe with a selector to follow one message or one session. */
  readonly store: ReadonlyStore<ChatState>;
  getSnapshot(): ChatSnapshot;
  subscribe(notify: () => void): () => void;
  selectSession(id: string): Promise<void>;
  createSession(title?: string): Promise<string>;
  /** One more page of history of the session (default: the selected one). */
  loadOlder(sessionID?: string): Promise<void>;
  /** Read a session's transcript and keep it current: a subagent session a view expands.
   * The selected session and running subagent sessions below it are loaded without this. */
  loadSession(id: string): Promise<void>;
  /** Resolves with the prompt's id once the server has admitted it. Allowed while the
   * session is running (see `PromptDraft.delivery`). */
  send(draft: PromptDraft): Promise<string>;
  /** Withdraw a prompt that has not been delivered yet. */
  cancelQueued(id: string, sessionID?: string): Promise<void>;
  /** Allowed while the session is running: the next step uses the model. */
  selectModel(model: ModelRef | undefined): Promise<void>;
  /** Stop the run of the session (default: the selected one; a subagent's id stops only it). */
  interrupt(sessionID?: string): Promise<void>;
  /** Drop the event stream and start over: connection, catalog, transcript. */
  reconnect(): Promise<void>;
  /** The request may belong to the selected session or to a subagent session below it. */
  replyPermission(id: string, decision: PermissionDecision): Promise<void>;
  /** Answer a form of any field types. The answer is checked against the form first. */
  replyForm(id: string, answer: FormAnswer): Promise<void>;
  cancelForm(id: string): Promise<void>;
  replyQuestion(id: string, answers: QuestionAnswers): Promise<void>;
  rejectQuestion(id: string): Promise<void>;
  /** Cancel a form this client cannot render, so it stops blocking the session. */
  dismissForm(id: string): Promise<void>;
  /** Acquire exclusive admission, or throw synchronously unless the chat is fully idle
   * (connected, loaded, not executing, no pending operation or request, not already held).
   * Until released, send, session create/select, model selection and reconnect are
   * rejected and the snapshot reports `held`. Replies and interrupt remain available.
   * This fences this controller only; it cannot stop work another client starts. */
  hold(reason: string): ChatHold;
  clearError(): void;
  /** Freeze admission, abort and join this client's requests and event stream.
   * Does not interrupt remote server execution. Repeated calls share completion. */
  dispose(): Promise<void>;
}
