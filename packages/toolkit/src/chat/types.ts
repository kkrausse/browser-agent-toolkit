import type {
  ModelRef,
  SessionInfo,
  SessionMessageInfo,
  PermissionRequest,
  FormInfo,
} from "./vendor/types";
/** Legacy public question view, explicitly adapted from question-tool forms. */
export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: { header: string; question: string; options: { label: string; description: string }[]; multiple?: boolean; custom?: boolean }[];
  tool?: { messageID: string; id: string };
}
export type {
  ModelRef,
  SessionInfo,
  SessionMessageInfo,
  PermissionRequest,
  FormInfo,
};
export interface ModelInfo extends ModelRef { name: string; enabled: boolean }
/** The OpenCode server as the chat reaches it: `path` is what the server sees
 * (`/api/session`). Authorization is the caller's concern (wrap `fetch`). */
export interface ChatEndpoint {
  fetch(path: string, init?: RequestInit): Promise<Response>;
}
export type PermissionDecision = "once" | "always" | "reject";
export type QuestionAnswers = string[][];
export type PromptDraft = { text: string };
export interface ChatOptions {
  endpoint: ChatEndpoint;
  directory: string;
  sessionID?: string;
  autoCreateSession?: boolean;
  /** Create a fresh session at initial connection rather than hydrating the latest history. */
  startNewSession?: boolean;
  pageSize?: number;
  handshakeTimeoutMs?: number;
  /** Optional observer of timing: connection milestones (`chat.connect` with a `stage`)
   * and one send's timeline (`chat.send.clicked|accepted|rejected`,
   * `chat.reply.first-event|first-text`, joined by `send`). Ids, counts and lengths only:
   * never session titles, messages or prompts. It must not throw. */
  onDiagnostic?(event: string, data?: Record<string, unknown>): void;
}
export type RequestState<T> = {
  request: T;
  submitting: boolean;
  error?: string;
};
export interface ChatSnapshot {
  connection: "connecting" | "connected" | "disconnected";
  sessionID?: string;
  sessions: readonly SessionInfo[];
  /** Controller-local logical conversation identity, including an uncreated new chat. */
  draftKey?: string;
  /** Session creation or model mutation has not completed. */
  sessionOperationPending?: boolean;
  /** Reason given to an active hold(). New sends, session and model changes are rejected. */
  held?: string;
  models: readonly ModelInfo[];
  model?: ModelRef;
  /** Resolved location default; does not mutate the session's model selection. */
  defaultModel?: ModelRef;
  messages: readonly SessionMessageInfo[];
  execution: "idle" | "running" | "retrying" | "unknown";
  interruptRequested: boolean;
  sending: boolean;
  loading: boolean;
  loadingOlder: boolean;
  hasOlder: boolean;
  permissions: readonly RequestState<PermissionRequest>[];
  questions: readonly RequestState<QuestionRequest>[];
  unsupportedForms: readonly FormInfo[];
  error?: string;
}
/** Exclusive admission lease. release() is idempotent and a no-op after dispose(). */
export interface ChatHold {
  release(): void;
}
export interface ChatController {
  readonly ready: Promise<void>;
  getSnapshot(): ChatSnapshot;
  subscribe(notify: () => void): () => void;
  selectSession(id: string): Promise<void>;
  createSession(title?: string): Promise<string>;
  loadOlder(): Promise<void>;
  send(draft: PromptDraft): Promise<void>;
  selectModel(model: ModelRef | undefined): Promise<void>;
  interrupt(): Promise<void>;
  reconnect(): Promise<void>;
  replyPermission(id: string, decision: PermissionDecision): Promise<void>;
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
