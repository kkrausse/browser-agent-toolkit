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
export interface ChatEndpoint {
  url: string;
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
export type PermissionDecision = "once" | "always" | "reject";
export type QuestionAnswers = string[][];
export type PromptDraft = { text: string };
/** Versioned transcript archive. This is not an OpenCode session import or resume bundle. */
export type ChatExport = {
  format: "opencode-chat";
  version: 1;
  portability: {
    resume: "unsupported";
    attachmentBytes: "not-included";
  };
  sessions: Array<{
    session: SessionInfo;
    messages: SessionMessageInfo[];
  }>;
};
export interface ChatOptions {
  endpoint: ChatEndpoint;
  directory: string;
  sessionID?: string;
  autoCreateSession?: boolean;
  /** Create a fresh session at initial connection rather than hydrating the latest history. */
  startNewSession?: boolean;
  pageSize?: number;
  handshakeTimeoutMs?: number;
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
export interface ChatController {
  readonly ready: Promise<void>;
  getSnapshot(): ChatSnapshot;
  subscribe(notify: () => void): () => void;
  selectSession(id: string): Promise<void>;
  createSession(title?: string): Promise<string>;
  loadOlder(): Promise<void>;
  exportChats(): Promise<ChatExport>;
  send(draft: PromptDraft): Promise<void>;
  selectModel(model: ModelRef | undefined): Promise<void>;
  interrupt(): Promise<void>;
  reconnect(): Promise<void>;
  replyPermission(id: string, decision: PermissionDecision): Promise<void>;
  replyQuestion(id: string, answers: QuestionAnswers): Promise<void>;
  rejectQuestion(id: string): Promise<void>;
  clearError(): void;
  /** Freeze admission, join local readers/finalizers and release the client runtime.
   * Does not interrupt or join remote server execution. Repeated calls share completion. */
  dispose(): Promise<void>;
}
