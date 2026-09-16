import { Context, Effect, Layer, Schema, Stream } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";
import { AbsolutePath, Form, Location, Model, OpenCode, Permission, Session, SessionMessage } from "@opencode/client/effect";
import type { SessionListInput } from "@opencode/client/effect/api";
import type { ModelRef, SessionInfo, SessionMessageInfo as Message, V2Event as NativeEvent, FormInfo, PermissionRequest } from "./vendor/types";
import type { ChatEndpoint as ClientEndpoint, ModelInfo } from "./types";
export type { ModelRef, SessionInfo, Message, NativeEvent };

export interface Page<T> { data: T[]; cursor: { next?: string | null } }

export interface ChatAPI {
  list(): Effect.Effect<SessionInfo[], ChatAPIError>;
  models(): Effect.Effect<ModelInfo[], ChatAPIError>;
  messages(id: string, options?: { cursor?: string; limit?: number; order?: "asc" | "desc" }): Effect.Effect<Page<Message>, ChatAPIError>;
  create(title?: string): Effect.Effect<SessionInfo, ChatAPIError>;
  model(id: string, model: ModelRef): Effect.Effect<void, ChatAPIError>;
  prompt(id: string, text: string): Effect.Effect<void, ChatAPIError>;
  interrupt(id: string): Effect.Effect<void, ChatAPIError>;
  active(): Effect.Effect<Readonly<Record<string, { readonly type: "running" }>>, ChatAPIError>;
  permissions(id: string): Effect.Effect<PermissionRequest[], ChatAPIError>;
  forms(id: string): Effect.Effect<FormInfo[], ChatAPIError>;
  replyPermission(id: string, requestID: string, reply: Permission.Reply): Effect.Effect<void, ChatAPIError>;
  replyForm(id: string, formID: string, answer: Form.Answer): Effect.Effect<void, ChatAPIError>;
  cancelForm(id: string, formID: string): Effect.Effect<void, ChatAPIError>;
  readonly events: Stream.Stream<NativeEvent, ChatAPIError>;
}

export class ChatError extends Schema.TaggedError<ChatError>()("ChatError", {
  message: Schema.String,
}) {}

/** Retain official errors as causes behind a portable service error type. */
export class ChatAPIError extends Schema.TaggedError<ChatAPIError>()("ChatAPIError", {
  cause: Schema.Defect(),
}) {}
const apiError = (cause: unknown) => new ChatAPIError({ cause });
const withAPIError = Effect.mapError(apiError);

/** Official decoding stays at the HTTP boundary. Encode schema values for the
 * existing immutable React snapshots/reducer (notably numeric timestamps).
 * The assertions only bridge the generated wire types' mutable array spelling. */
const sessionWire = (value: Session.Info) => Schema.encodeSync(Session.Info)(value) as SessionInfo;
const messageWire = (value: SessionMessage.Info) => Schema.encodeSync(SessionMessage.Info)(value) as Message;
const formWire = (value: Form.Info) => Schema.encodeSync(Form.Info)(value) as FormInfo;
const permissionWire = (value: Permission.Request) => Schema.encodeSync(Permission.Request)(value) as PermissionRequest;

const makeAPI = Effect.fn("OpenCodeAPI.make")(function*(directory: string, baseUrl: string): Effect.fn.Return<ChatAPI, never, HttpClient.HttpClient> {
  const client = yield* OpenCode.make({ baseUrl });
  const location = Location.Ref.make({ directory: AbsolutePath.make(directory) });
  const list = Effect.fn("OpenCodeAPI.list")(function*() {
    const items: SessionInfo[] = [], seen = new Set<string>();
    let cursor: SessionListInput["cursor"];
    do {
      const page = yield* client.session.list({ directory: location.directory, ...(cursor ? { cursor } : { order: "desc" }) });
      items.push(...page.data.map(sessionWire));
      cursor = page.cursor.next;
      if (cursor && seen.has(cursor)) return yield* new ChatError({ message: "Repeated V2 pagination cursor" });
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }, withAPIError);
  const models = Effect.fn("OpenCodeAPI.models")(function*() {
    yield* client.plugin.awaitActivation({ location });
    const result = yield* client.model.list({ location });
    return result.data.map(model => ({ id: model.id, providerID: model.providerID, name: model.name, enabled: model.enabled }));
  }, withAPIError);
  const messages = Effect.fn("OpenCodeAPI.messages")(function*(id: string, options: { cursor?: string; limit?: number; order?: "asc" | "desc" } = {}) {
    const page = yield* client.message.list({ sessionID: Session.ID.make(id), ...options });
    return { data: page.data.map(messageWire), cursor: page.cursor };
  }, withAPIError);
  return {
    list, models, messages,
    create: Effect.fn("OpenCodeAPI.create")(function*(title?: string) {
      return sessionWire(yield* client.session.create({ title, location }));
    }, withAPIError),
    model: Effect.fn("OpenCodeAPI.model")(function*(id: string, model: ModelRef) {
      yield* client.session.switchModel({ sessionID: Session.ID.make(id), model: yield* Schema.decodeUnknownEffect(Model.Ref)(model) });
    }, withAPIError),
    prompt: Effect.fn("OpenCodeAPI.prompt")(function*(id: string, text: string) {
      yield* client.session.prompt({ sessionID: Session.ID.make(id), text });
    }, withAPIError),
    interrupt: Effect.fn("OpenCodeAPI.interrupt")(function*(id: string) {
      yield* client.session.interrupt({ sessionID: Session.ID.make(id) });
    }, withAPIError),
    active: () => client.session.active().pipe(withAPIError),
    permissions: Effect.fn("OpenCodeAPI.permissions")(function*(id: string) {
      return (yield* client.permission.list({ sessionID: Session.ID.make(id) })).map(permissionWire);
    }, withAPIError),
    forms: Effect.fn("OpenCodeAPI.forms")(function*(sessionID: string) {
      return (yield* client.form.list({ sessionID })).map(formWire);
    }, withAPIError),
    replyPermission: Effect.fn("OpenCodeAPI.replyPermission")(function*(id: string, requestID: string, reply: Permission.Reply) {
      yield* client.permission.reply({ sessionID: Session.ID.make(id), requestID: Permission.ID.make(requestID), reply });
    }, withAPIError),
    replyForm: Effect.fn("OpenCodeAPI.replyForm")(function*(sessionID: string, formID: string, answer: Form.Answer) {
      yield* client.form.reply({ sessionID, formID: Form.ID.make(formID), answer });
    }, withAPIError),
    cancelForm: Effect.fn("OpenCodeAPI.cancelForm")(function*(sessionID: string, formID: string) {
      yield* client.form.cancel({ sessionID, formID: Form.ID.make(formID) });
    }, withAPIError),
    events: client.event.subscribe().pipe(Stream.map(value => value as NativeEvent), Stream.mapError(apiError)),
  };
});

/** One official client and shared event source per controller runtime. No native
 * service discovery; every request uses the caller's browser-workspace fetch. */
export class OpenCodeAPI extends Context.Service<OpenCodeAPI, ChatAPI>()("opencode-chat/OpenCodeAPI") {
  static layer(endpoint: ClientEndpoint, directory: string) {
    const base = new URL(endpoint.url);
    base.hash = "";
    const baseUrl = base.origin + base.pathname.replace(/\/$/, "");
    const transport = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      for (const key of new Set(base.searchParams.keys())) {
        if (!url.searchParams.has(key))
          for (const value of base.searchParams.getAll(key)) url.searchParams.append(key, value);
      }
      return endpoint.fetch(url.href, init);
    };
    return Layer.effect(OpenCodeAPI, makeAPI(directory, baseUrl)).pipe(
      Layer.provide(FetchHttpClient.layer),
      // Bun's ambient fetch type also declares preconnect; browser HTTP uses only fetch.
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, transport as typeof globalThis.fetch)),
    );
  }
}
