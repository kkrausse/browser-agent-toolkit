import type { ModelRef, SessionInfo, SessionInboxUser, SessionMessageInfo as Message, V2Event as NativeEvent, FormInfo, PermissionRequest } from './vendor/types';
import type { ChatEndpoint, ModelInfo, PermissionDecision } from './types';
export type { NativeEvent, Message };

/**
 * The OpenCode 2.0.3 HTTP API as this chat uses it: REST plus one SSE stream, over the
 * caller's endpoint fetch. Paths, queries, bodies and `data` unwrapping follow
 * `@opencode/client@2.0.3` (`dist/promise/generated/client.js`); wire types are the
 * generated ones in `./vendor/types`.
 */
export interface Page<T> { data: T[]; cursor: { next?: string | null } }
export type MessagePageOptions = { cursor?: string; limit?: number; order?: 'asc' | 'desc' };

export interface ChatAPI {
  list(signal: AbortSignal): Promise<SessionInfo[]>;
  /** Awaits plugin activation first: plugins edit the catalog. */
  models(signal: AbortSignal): Promise<ModelInfo[]>;
  defaultModel(signal: AbortSignal): Promise<ModelRef | undefined>;
  messages(id: string, options: MessagePageOptions, signal: AbortSignal): Promise<Page<Message>>;
  create(title: string | undefined, signal: AbortSignal): Promise<SessionInfo>;
  model(id: string, model: ModelRef, signal: AbortSignal): Promise<void>;
  /** Resolves with the accepted inbox entry; its id names the later `session.inbox.delivered`. */
  prompt(id: string, text: string, signal: AbortSignal): Promise<SessionInboxUser>;
  interrupt(id: string, signal: AbortSignal): Promise<void>;
  active(signal: AbortSignal): Promise<Record<string, unknown>>;
  permissions(id: string, signal: AbortSignal): Promise<PermissionRequest[]>;
  forms(id: string, signal: AbortSignal): Promise<FormInfo[]>;
  replyPermission(id: string, requestID: string, reply: PermissionDecision, signal: AbortSignal): Promise<void>;
  replyForm(id: string, formID: string, answer: Record<string, unknown>, signal: AbortSignal): Promise<void>;
  cancelForm(id: string, formID: string, signal: AbortSignal): Promise<void>;
  /** Ends when the server closes the stream; throws on transport failure or abort. */
  events(signal: AbortSignal): AsyncGenerator<NativeEvent>;
}

const maxEventBytes = 16 * 1024 * 1024;

export function createChatAPI(endpoint: ChatEndpoint, directory: string): ChatAPI {
  const location = { 'location[directory]': directory };
  const call = async (signal: AbortSignal, method: string, path: string, options: { query?: Record<string, string | number | undefined>; body?: unknown } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) query.append(key, String(value));
    const response = await endpoint.fetch(path + (query.size ? `?${query}` : ''), {
      method, signal,
      headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      let message = detail.slice(0, 500);
      try { const parsed = JSON.parse(detail); message = parsed.message ?? parsed.error?.message ?? message; } catch { /* not JSON */ }
      throw Error(`OpenCode ${method} ${path}: HTTP ${response.status}${message ? ` ${message}` : ''}`);
    }
    if (response.status === 204) return undefined;
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  };
  const session = (id: string) => `/api/session/${encodeURIComponent(id)}`;
  return {
    async list(signal) {
      const items: SessionInfo[] = [], seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page: Page<SessionInfo> = await call(signal, 'GET', '/api/session', { query: { directory, ...(cursor ? { cursor } : { order: 'desc' }) } });
        items.push(...page.data);
        cursor = page.cursor?.next ?? undefined;
        if (cursor && seen.has(cursor)) throw Error('Repeated session pagination cursor');
        if (cursor) seen.add(cursor);
      } while (cursor);
      return items;
    },
    async models(signal) {
      await call(signal, 'POST', '/api/plugin/await-activation', { query: location });
      const result = await call(signal, 'GET', '/api/model', { query: location });
      return (result.data as ModelInfo[]).map(model => ({ id: model.id, providerID: model.providerID, name: model.name, enabled: model.enabled }));
    },
    async defaultModel(signal) {
      const result = await call(signal, 'GET', '/api/model/default', { query: location });
      return result?.data ? { id: result.data.id, providerID: result.data.providerID } : undefined;
    },
    messages: (id, options, signal) => call(signal, 'GET', `${session(id)}/message`, { query: options }),
    create: async (title, signal) => (await call(signal, 'POST', '/api/session', { body: { title, location: { directory } } })).data,
    model: (id, model, signal) => call(signal, 'POST', `${session(id)}/model`, { body: { model } }),
    prompt: async (id, text, signal) => (await call(signal, 'POST', `${session(id)}/prompt`, { body: { text } })).data,
    interrupt: async (id, signal) => { await call(signal, 'POST', `${session(id)}/interrupt`); },
    active: async signal => (await call(signal, 'GET', '/api/session/active')).data,
    permissions: async (id, signal) => (await call(signal, 'GET', `${session(id)}/permission`)).data,
    forms: async (id, signal) => (await call(signal, 'GET', `${session(id)}/form`)).data,
    replyPermission: (id, requestID, reply, signal) => call(signal, 'POST', `${session(id)}/permission/${encodeURIComponent(requestID)}/reply`, { body: { reply } }),
    replyForm: (id, formID, answer, signal) => call(signal, 'POST', `${session(id)}/form/${encodeURIComponent(formID)}/reply`, { body: { answer } }),
    cancelForm: (id, formID, signal) => call(signal, 'POST', `${session(id)}/form/${encodeURIComponent(formID)}/cancel`),
    async *events(signal) {
      const response = await endpoint.fetch('/api/event', { signal, headers: { accept: 'text/event-stream' } });
      if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw Error(`OpenCode event stream: HTTP ${response.status}`); }
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const next = await reader.read();
          buffer += decoder.decode(next.value, { stream: !next.done });
          if (buffer.length > maxEventBytes) throw Error('OpenCode event too large');
          // A chunk may end between the two bytes of a CRLF.
          const heldCR = !next.done && buffer.endsWith('\r');
          if (heldCR) buffer = buffer.slice(0, -1);
          buffer = buffer.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
          if (heldCR) buffer += '\r';
          if (next.done && buffer) buffer += '\n\n';
          for (let boundary = buffer.indexOf('\n\n'); boundary >= 0; boundary = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = block.split('\n').flatMap(line => line.startsWith('data:') ? [line.slice(5).trimStart()] : []).join('\n');
            if (data) yield JSON.parse(data) as NativeEvent;
          }
          if (next.done) return;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
}
