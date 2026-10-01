import { Cause, Deferred, Effect, Exit, Fiber, ManagedRuntime, Scope, Stream } from "effect";
import { ChatError, OpenCodeAPI, type ChatAPIError, type NativeEvent } from "./api";
import { createV2SessionReducer } from "./vendor/reducer";
import { questionFromForm, formAnswer } from "./forms";
import { createReaderFence } from "./reader-fence";
import { canSend, holdBlocker } from "./admission";
import type {
  ChatController,
  ChatExport,
  ChatOptions,
  ChatSnapshot,
  ModelRef,
  QuestionRequest,
  QuestionAnswers,
} from "./types";

// The package root is built from this module, so runtime exports live here.
export { canSend };

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const compareID = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}

/** Owns only its local state and injected HTTP requests. Creation never creates a session by default. */
export function createChatController(options: ChatOptions): ChatController {
  if (!options.directory?.trim())
    throw new Error("Caller directory is required");
  const readers = createReaderFence(options.endpoint);
  const runtime = ManagedRuntime.make(OpenCodeAPI.layer(readers.endpoint, options.directory));
  const lifetime = Scope.makeUnsafe();
  const reducer = createV2SessionReducer();
  let state: ChatSnapshot = freeze({
    connection: "connecting",
    sessionID: options.sessionID,
    draftKey: options.sessionID ? `session:${options.sessionID}` : undefined,
    sessions: [],
    models: [],
    messages: [],
    execution: "unknown",
    interruptRequested: false,
    sending: false,
    loading: true,
    loadingOlder: false,
    hasOlder: false,
    permissions: [],
    questions: [],
    unsupportedForms: [],
  });
  const listeners = new Set<() => void>();
  let disposed = false,
    generation = 0,
    selection = 0,
    revision = 0;
  let connection = Scope.forkUnsafe(lifetime),
    selectionScope = Scope.forkUnsafe(connection);
  let older: string | undefined | null, hydration: Fiber.Fiber<void, ChatAPIError | ChatError> | undefined;
  let requestEvents: NativeEvent[] = [];
  const answered = new Set<string>();
  const dismissing = new Set<string>();
  let recovery: Fiber.Fiber<void, never> | undefined;
  let mutation: symbol | undefined;
  let draftSequence = 0;
  const draftKeys = new Map<string, string>();
  let disposal: Promise<void> | undefined;
  // `mutation` is the only record of a pending session operation. The snapshot
  // flag is stamped on every publish so the two cannot drift.
  const publish = (patch: Partial<Omit<ChatSnapshot, "sessionOperationPending">>) => {
    if (disposed) return;
    state = freeze({ ...state, ...patch, sessionOperationPending: !!mutation });
    for (const listener of listeners) listener();
  };
  const check = () => {
    if (disposed) throw new Error("Chat controller is disposed");
  };
  const sessionID = Effect.fn("Chat.sessionID")(function*() {
    const id = state.sessionID;
    if (!id) return yield* new ChatError({ message: "Select a session first" });
    return id;
  });
  const valid = (g: number, s: number) =>
    !disposed && g === generation && s === selection;
  const action = <A, E>(effect: Effect.Effect<A, E, OpenCodeAPI>, g = generation, s = selection) => Effect.suspend(() => {
    check();
    return effect.pipe(Effect.tapCause(cause => Effect.sync(() => {
      if (valid(g, s) && !Cause.hasInterrupts(cause)) publish({ error: Cause.pretty(cause) });
    })));
  });
  // Promises exist only at the public React boundary; scopes own all request fibers.
  const run = <A, E>(effect: Effect.Effect<A, E, OpenCodeAPI>, scope = selectionScope) => {
    if (disposed) return Promise.reject(new Error("Chat controller is disposed"));
    return runtime.runPromise(action(effect).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join),
      Effect.catchCause(cause => Effect.fail(new ChatError({ message: Cause.pretty(cause) })))));
  };
  // Archive reads must not publish errors or depend on the selected session.
  // The root lifetime still guarantees that disposal cancels their requests.
  const runArchive = <A, E>(effect: Effect.Effect<A, E, OpenCodeAPI>) => {
    check();
    return runtime.runPromise(effect.pipe(
      Effect.forkIn(lifetime),
      Effect.flatMap(Fiber.join),
      Effect.catchCause(cause => Effect.fail(new ChatError({ message: Cause.pretty(cause) }))),
    ));
  };
  function recover() {
    if (disposed || recovery || state.connection !== "connected") return;
    const g = generation,
      s = selection;
    const scope = selectionScope;
    runtime.runFork(Effect.gen(function*() {
      recovery = yield* Effect.gen(function*() {
        yield* Effect.sleep(120);
        recovery = undefined;
        if (valid(g, s)) yield* hydrate();
      }).pipe(
        Effect.catchCause(cause => Effect.sync(() => {
          if (valid(g, s) && !Cause.hasInterrupts(cause)) publish({ error: Cause.pretty(cause) });
        })),
        Effect.forkIn(scope),
      );
    }));
  }
  const hydrate = Effect.fn("Chat.hydrate")(function*(): Effect.fn.Return<void, ChatAPIError | ChatError, OpenCodeAPI> {
    if (hydration) return yield* Fiber.join(hydration);
    if (!state.sessionID) return;
    const g = generation,
      s = selection,
      rev = revision,
      id = yield* sessionID();
    requestEvents = [];
    const task = yield* Effect.gen(function*() {
      const api = yield* OpenCodeAPI;
      const [page, permissions, forms, active] = yield* Effect.all([
        api.messages(id, { order: "desc", limit: options.pageSize ?? 50 }),
        api.permissions(id), api.forms(id), api.active(),
      ], { concurrency: "unbounded" });
      if (!valid(g, s)) return;
      // HTTP snapshots have no shared SSE cursor. Never replay overlapping deltas:
      // they may already be persisted. Refetch after the overlap instead.
      const messages = [...page.data].reverse();
      const ids = new Set(messages.map((m) => m.id));
      const prefix = state.messages.filter((m) => !ids.has(m.id));
      const first = messages[0]?.time.created ?? 0;
      const previous = prefix.filter((m) => m.time.created < first);
      if (!previous.length) older = page.cursor.next;
      publish({
        messages: [...previous, ...messages],
        hasOlder: !!older,
        permissions: permissions
          .filter((r) => !answered.has(`permission:${r.id}`))
          .map((request) => ({
            submitting: false,
            ...state.permissions.find((p) => p.request.id === request.id),
            request,
          })),
        unsupportedForms: forms.filter(f => !answered.has(`question:${f.id}`) && !questionFromForm(f)),
        questions: forms.flatMap(f => { const q = questionFromForm(f); return q ? [q] : []; })
          .filter((r) => !answered.has(`question:${r.id}`))
          .map((request) => ({
            submitting: false,
            ...state.questions.find((p) => p.request.id === request.id),
            request,
          })),
        ...(revision === rev
          ? {
              execution: active[id]
                ? ("running" as const)
                : ("idle" as const),
              ...(!active[id]
                ? { interruptRequested: false }
                : {}),
            }
          : {}),
        loading: false,
      });
      if (older) {
        publish({ loadingOlder: true });
        yield* drainOlder(g, s).pipe(Effect.ensuring(Effect.sync(() => {
          if (valid(g, s)) publish({ loadingOlder: false });
        })));
      }
      for (const e of requestEvents) requestEvent(e);
      if (revision !== rev) recover();
    }).pipe(Effect.forkIn(selectionScope));
    hydration = task;
    yield* Fiber.join(task).pipe(Effect.ensuring(Effect.sync(() => {
      if (hydration === task) hydration = undefined;
    })));
  });
  function requestEvent(e: NativeEvent) {
    if (e.type === "permission.asked")
      publish({
        permissions: [
          ...state.permissions.filter((p) => p.request.id !== e.data.id),
          { request: e.data, submitting: false },
        ],
      });
    if (e.type === "form.created") {
      const form = e.data.form;
      const request = questionFromForm(form);
      if (answered.has(`question:${form.id}`)) return;
      if (request) publish({
        questions: [
          ...state.questions.filter((p) => p.request.id !== form.id),
          { request, submitting: false },
        ],
      });
      else publish({ unsupportedForms: [...state.unsupportedForms.filter(f => f.id !== form.id), form] });
    }
    if (e.type === "permission.replied") {
      answered.add(`permission:${e.data.requestID}`);
      publish({
        permissions: state.permissions.filter(
          (p) => p.request.id !== e.data.requestID,
        ),
      });
    }
    if (e.type === "form.replied" || e.type === "form.cancelled") {
      answered.add(`question:${e.data.id}`);
      publish({
        unsupportedForms: state.unsupportedForms.filter(f => f.id !== e.data.id),
        questions: state.questions.filter(
          (p) => p.request.id !== e.data.id,
        ),
      });
    }
  }
  function event(e: NativeEvent) {
    if (e.type === "session.renamed") {
      publish({ sessions: state.sessions.map(session =>
        session.id === e.data.sessionID ? { ...session, title: e.data.title } : session,
      ) });
      return;
    }
    const sessionID = e.type === "form.created" ? e.data.form.sessionID :
      "sessionID" in e.data ? e.data.sessionID : undefined;
    if (
      !sessionID || sessionID !== state.sessionID
    )
      return;
    revision++;
    requestEvent(e);
    if (hydration && /^(permission|form)\./.test(e.type))
      requestEvents.push(e);
    if (e.type === "session.execution.started")
      publish({ execution: "running" });
    if (e.type === "session.retry.scheduled")
      publish({ execution: "retrying" });
    if (e.type === "session.status")
      publish({
        execution:
          e.data.status.type === "idle"
            ? "idle"
            : e.data.status.type === "retry"
              ? "retrying"
              : "running",
        ...(e.data.status.type === "idle" ? { interruptRequested: false } : {}),
      });
    if (e.type === "session.model.selected") publish({ model: e.data.model });
    if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(e.type)) {
      publish({
        execution: "idle",
        interruptRequested: false,
        ...("error" in e.data
          ? { error: errorText(JSON.stringify(e.data.error)) }
          : {}),
      });
      recover();
    }
    if (hydration) {
      recover();
      return;
    }
    const before = state.messages;
    const reduced = reducer.reduce(before, e);
    if (reduced?.touched.length) publish({ messages: reduced.messages });
    if (
      reduced &&
      "assistantMessageID" in e.data &&
      /\.(delta|success|failed)$/.test(e.type)
    ) {
      const id = e.data.assistantMessageID,
        old = before.find((m) => m.id === id),
        next = reduced.messages.find((m) => m.id === id);
      if (
        old?.type === "assistant" &&
        next?.type === "assistant" &&
        old.content.every((p, i) => next.content[i] === p)
      )
        recover();
    }
    if (
      reduced?.missing ||
      (reduced && !reduced.touched.length && "assistantMessageID" in e.data)
    )
      recover();
    if (
      e.type === "session.inbox.delivered" ||
      e.type === "session.instructions.updated" ||
      e.type === "session.moved" ||
      e.type === "session.model.selected"
    )
      recover();
    if (
      /^session\.(text|reasoning|tool\.input)\.ended$/.test(e.type) ||
      e.type === "session.step.ended"
    )
      recover();
  }
  // Selection is user intent, not asynchronous request work. Publish before the
  // public call returns, so the next input event cannot address the old draft.
  const selectSession = (id: string | undefined, draftKey?: string, preserveMutation = false) => {
    check();
    const previous = selectionScope;
    selectionScope = Scope.forkUnsafe(connection);
    selection++;
    hydration = undefined;
    if (!preserveMutation) mutation = undefined;
    recovery = undefined;
    if (state.sessionID) reducer.clear(state.sessionID);
    answered.clear();
    older = undefined;
    publish({
      sessionID: id,
      draftKey: draftKey ?? (id ? draftKeys.get(id) ?? `session:${id}` : undefined),
      model: state.sessions.find((s) => s.id === id)?.model,
      messages: [],
      permissions: [],
      questions: [],
      unsupportedForms: [],
      loading: !!id || !!mutation,
      loadingOlder: false,
      hasOlder: false,
      execution: id || mutation ? "unknown" : "idle",
      sending: false,
      interruptRequested: false,
    });
    const g = generation,
      s = selection;
    return Effect.gen(function*() {
      yield* Scope.close(previous, Exit.void);
      if (!valid(g, s)) return;
      yield* action(hydrate()).pipe(Effect.ensuring(Effect.sync(() => {
        if (valid(g, s)) publish({ loading: false });
      })));
    });
  };
  const reconnect = Effect.fn("Chat.reconnect")(function*() {
    check();
    generation++;
    const previous = connection;
    connection = Scope.forkUnsafe(lifetime);
    selectionScope = Scope.forkUnsafe(connection);
    mutation = undefined;
    hydration = undefined;
    recovery = undefined;
    const g = generation,
      scope = connection,
      selectionAtStart = selection;
    if (state.sessionID) reducer.clear(state.sessionID);
    publish({
      connection: "connecting",
      loading: true,
      error: undefined,
      execution: "unknown",
      sending: false,
    });
    yield* Scope.close(previous, Exit.void);
    const setup = Effect.gen(function*() {
      const api = yield* OpenCodeAPI;
      const marker = yield* Deferred.make<void, ChatAPIError | ChatError>();
      yield* api.events.pipe(
        Stream.runForEach(e => Effect.gen(function*() {
          if (g !== generation || disposed) return;
          if (e.type === "server.connected") yield* Deferred.succeed(marker, undefined);
          event(e);
        })),
        Effect.andThen(new ChatError({ message: "OpenCode event connection closed. Reconnect to reload history." })),
        Effect.catchCause(cause => Effect.gen(function*() {
          yield* Deferred.failCause(marker, cause);
          if (g !== generation || disposed || Cause.hasInterrupts(cause)) return;
          publish({ connection: "disconnected", execution: "unknown", loading: false, error: Cause.pretty(cause) });
          // Close from a separate lifetime fiber so the stream never joins itself.
          yield* Scope.close(scope, Exit.void).pipe(Effect.forkIn(lifetime));
        })),
        Effect.forkIn(scope),
      );
      yield* Deferred.await(marker).pipe(Effect.timeoutOrElse({
        duration: options.handshakeTimeoutMs ?? 15000,
        orElse: () => new ChatError({ message: "OpenCode event handshake timed out" }),
      }));
      const [sessions, models] = yield* Effect.all([api.list(), api.models()], { concurrency: "unbounded" });
      // models() awaits plugin activation before resolving the same location's default.
      const defaultModel = yield* api.defaultModel();
      if (g !== generation || disposed) return;
      publish({ sessions, models, defaultModel, connection: "connected" });
      if (selection !== selectionAtStart) return;
      const id = state.sessionID ?? sessions[0]?.id;
      if (options.startNewSession && !state.sessionID) yield* createSession();
      else if (id) yield* selectSession(id);
      else if (options.autoCreateSession) yield* createSession();
      else publish({ loading: false, execution: "idle" });
    });
    yield* setup.pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join), Effect.catchCause(cause => Effect.gen(function*() {
      if (g === generation && !disposed) {
        publish({
          connection: "disconnected",
          loading: false,
          error: state.error ?? Cause.pretty(cause),
        });
        yield* Scope.close(scope, Exit.void);
      }
      return yield* Effect.failCause(cause);
    })));
  });
  const reply = Effect.fn("Chat.reply")(function*(
    kind: "permission" | "question",
    id: string,
    submit: (api: OpenCodeAPI["Service"], sessionID: string) => Effect.Effect<void, ChatAPIError>,
  ) {
    const list = kind === "permission" ? state.permissions : state.questions;
    const entry = list.find((p) => p.request.id === id);
    if (!entry) return yield* new ChatError({ message: "Request is no longer pending" });
    if (entry.submitting) return yield* new ChatError({ message: "Response is already submitting" });
    const g = generation, s = selection;
    const update = (error?: string, submitting = false, remove = false) => {
      if (!valid(g, s)) return;
      if (kind === "permission")
        publish({
          permissions: state.permissions.flatMap((p) =>
            p.request.id !== id ? [p] : remove ? [] : [{ ...p, error, submitting }],
          ),
        });
      else
        publish({
          questions: state.questions.flatMap((p) =>
            p.request.id !== id ? [p] : remove ? [] : [{ ...p, error, submitting }],
          ),
        });
    };
    update(undefined, true);
    yield* submit(yield* OpenCodeAPI, yield* sessionID()).pipe(
      Effect.tapCause(cause => Effect.sync(() => update(Cause.pretty(cause)))),
    );
    if (valid(g, s)) answered.add(`${kind}:${id}`);
    update(undefined, false, true);
  });
  const createSession = (title?: string) => {
    check();
    if (mutation) return Effect.fail(new ChatError({ message: "A session operation is pending" }));
    const token = (mutation = Symbol());
    // Admission must not be deferred into runPromise/forkIn. Retry retains the
    // uncreated draft; a new intent from a real session allocates a fresh key.
    const key = !state.sessionID && state.draftKey
      ? state.draftKey : `new:${++draftSequence}`;
    const transition = selectSession(undefined, key, true);
    const g = generation, s = selection;
    return Effect.gen(function*() {
      yield* transition;
      if (!valid(g, s) || mutation !== token)
        return yield* new ChatError({ message: "Session creation was abandoned" });
      const api = yield* OpenCodeAPI;
      // A custom title suppresses OpenCode's automatic first-prompt naming.
      const session = yield* action(api.create(title));
      if (valid(g, s)) {
        draftKeys.set(session.id, key);
        publish({ sessions: [session, ...state.sessions] });
        yield* selectSession(session.id, key, true);
      }
      return session.id;
    }).pipe(Effect.ensuring(Effect.sync(() => {
      if (mutation === token) {
        mutation = undefined;
        publish({ loading: false });
      }
    })));
  };
  const drainOlder = Effect.fn("Chat.drainOlder")(function*(g: number, s: number) {
    const cursors = new Set<string>();
    while (older && valid(g, s)) {
      const cursor = older;
      cursors.add(cursor);
      const api = yield* OpenCodeAPI;
      const page = yield* api.messages(yield* sessionID(), {
        cursor,
        limit: options.pageSize ?? 50,
      });
      if (!valid(g, s)) return;
      if (page.cursor.next && cursors.has(page.cursor.next)) {
        older = undefined;
        publish({ hasOlder: false });
        return yield* new ChatError({ message: "Repeated history cursor" });
      }
      older = page.cursor.next;
      const ids = new Set(state.messages.map((m) => m.id));
      publish({
        messages: [...page.data].reverse().filter((m) => !ids.has(m.id)).concat([...state.messages]),
        hasOlder: !!older,
      });
    }
  });
  const loadOlder = Effect.fn("Chat.loadOlder")(function*() {
    if (!older || state.loadingOlder || hydration) return;
    const g = generation, s = selection;
    publish({ loadingOlder: true });
    yield* drainOlder(g, s).pipe(Effect.ensuring(Effect.sync(() => {
      if (valid(g, s)) publish({ loadingOlder: false });
    })));
  });
  const exportChats = Effect.fn("Chat.exportChats")(function*(): Effect.fn.Return<ChatExport, ChatAPIError | ChatError, OpenCodeAPI> {
    const api = yield* OpenCodeAPI;
    const sessions = [...new Map((yield* api.list()).map(session => [session.id, session])).values()];
    const exported = yield* Effect.forEach(sessions, session => Effect.gen(function*() {
      const messages = new Map<string, ChatExport["sessions"][number]["messages"][number]>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = yield* api.messages(session.id, cursor
          ? { cursor, limit: options.pageSize ?? 50 }
          : { order: "desc", limit: options.pageSize ?? 50 });
        // Descending pages can overlap. Retain the first (newest-page) copy.
        for (const message of page.data)
          if (!messages.has(message.id)) messages.set(message.id, message);
        const next = page.cursor.next ?? undefined;
        if (next && cursors.has(next))
          return yield* new ChatError({ message: `Repeated export history cursor for session ${session.id}` });
        if (next) cursors.add(next);
        cursor = next;
      } while (cursor);
      return {
        session,
        messages: [...messages.values()].sort((a, b) =>
          a.time.created - b.time.created || compareID(a.id, b.id)),
      };
    }), { concurrency: "unbounded" });
    exported.sort((a, b) =>
      a.session.time.created - b.session.time.created || compareID(a.session.id, b.session.id));
    return {
      format: "opencode-chat",
      version: 1,
      portability: {
        resume: "unsupported",
        attachmentBytes: "not-included",
      },
      sessions: exported,
    };
  });
  const send = Effect.fn("Chat.send")(function*(draft: { text: string }) {
    if (!draft.text.trim()) return yield* new ChatError({ message: "Enter a message" });
    // Re-checked inside the request fiber: a hold may be acquired after the
    // public call was admitted but before this runs.
    if (!canSend(state)) return yield* new ChatError({ message: "Chat is not ready to send" });
    const g = generation, s = selection, id = yield* sessionID();
    publish({ sending: true, error: undefined });
    yield* Effect.gen(function*() {
      const api = yield* OpenCodeAPI;
      yield* api.prompt(id, draft.text);
      if (valid(g, s)) {
        yield* hydrate().pipe(Effect.catchCause(cause => Effect.sync(() => {
          // Prompt acceptance is known. A refresh failure must not invite a
          // duplicate submission of an already accepted prompt.
          if (valid(g, s)) publish({
            error: `Message accepted; refresh failed: ${Cause.pretty(cause)}`,
            execution: "unknown",
          });
        })));
      }
    }).pipe(Effect.ensuring(Effect.sync(() => {
      if (valid(g, s)) publish({ sending: false });
    })));
  });
  const selectModel = Effect.fn("Chat.selectModel")(function*(model: ModelRef | undefined) {
    if (!model)
      return yield* new ChatError({ message: "Select an explicit model; the pinned API cannot reset a session model" });
    if (state.execution !== "idle" || mutation || state.sending || state.held)
      return yield* new ChatError({ message: "Wait for the current operation" });
    const id = yield* sessionID();
    const g = generation, s = selection, token = (mutation = Symbol());
    publish({}); // republishes the derived pending flag
    yield* Effect.gen(function*() {
      const api = yield* OpenCodeAPI;
      yield* api.model(id, model);
      if (valid(g, s)) publish({
        model,
        sessions: state.sessions.map(session => session.id === id ? { ...session, model } : session),
      });
    }).pipe(Effect.ensuring(Effect.sync(() => {
      if (mutation === token) {
        mutation = undefined;
        publish({});
      }
    })));
  });
  const interrupt = Effect.fn("Chat.interrupt")(function*() {
    const id = yield* sessionID(), g = generation, s = selection;
    publish({ interruptRequested: true });
    const api = yield* OpenCodeAPI;
    yield* api.interrupt(id);
    if (valid(g, s)) yield* hydrate();
  });
  const replyQuestion = Effect.fn("Chat.replyQuestion")(function*(id: string, answers: QuestionAnswers) {
    yield* validateAnswers(state.questions.find(q => q.request.id === id)?.request, answers);
    const request = state.questions.find(q => q.request.id === id)!.request;
    yield* reply("question", id, (api, sessionID) => api.replyForm(sessionID, id, formAnswer(request, answers)));
  });
  // Unsupported forms have no reply the legacy question UI can express. Cancelling
  // is the only answer this client can give, and it unblocks the session.
  const dismissForm = Effect.fn("Chat.dismissForm")(function*(id: string) {
    if (!state.unsupportedForms.some(f => f.id === id))
      return yield* new ChatError({ message: "Form is no longer pending" });
    if (dismissing.has(id)) return yield* new ChatError({ message: "Response is already submitting" });
    const g = generation, s = selection, session = yield* sessionID();
    const api = yield* OpenCodeAPI;
    dismissing.add(id);
    yield* api.cancelForm(session, id).pipe(Effect.ensuring(Effect.sync(() => dismissing.delete(id))));
    if (!valid(g, s)) return;
    answered.add(`question:${id}`);
    publish({ unsupportedForms: state.unsupportedForms.filter(f => f.id !== id) });
  });
  // A hold freezes new intent at the public boundary. Bootstrap selection is
  // internal and not routed through here; replies and interrupt stay available.
  const unheld = <A>(intent: () => Promise<A>): Promise<A> =>
    state.held && !disposed
      ? Promise.reject(new ChatError({ message: `Chat is held: ${state.held}` }))
      : intent();
  const admit = <A, E>(intent: () => Effect.Effect<A, E, OpenCodeAPI>) => {
    try { return run(intent(), connection); }
    catch (error) { return Promise.reject(error); }
  };
  const controller: ChatController = {
    ready: undefined as unknown as Promise<void>,
    getSnapshot: () => state,
    subscribe(notify) {
      check();
      listeners.add(notify);
      return () => { listeners.delete(notify); };
    },
    selectSession: id => unheld(() => admit(() => selectSession(id))),
    reconnect: () => unheld(() => run(reconnect(), lifetime)),
    createSession: title => unheld(() => admit(() => createSession(title))),
    loadOlder: () => run(loadOlder()),
    exportChats: () => runArchive(exportChats()),
    send: draft => unheld(() => {
      // A rejected pending intent must never become a queued send merely because
      // readiness/selection changes before the request fiber gets scheduled.
      if (disposed) return Promise.reject(new Error("Chat controller is disposed"));
      if (!canSend(state)) return Promise.reject(new ChatError({ message: "Chat is not ready to send" }));
      const g = generation, s = selection;
      return run(Effect.suspend(() => valid(g, s)
        ? send(draft)
        : Effect.fail(new ChatError({ message: "Send selection changed" }))));
    }),
    selectModel: model => unheld(() => run(selectModel(model))),
    interrupt: () => run(interrupt()),
    replyPermission: (id, decision) =>
      run(reply("permission", id, (api, sessionID) => api.replyPermission(sessionID, id, decision))),
    replyQuestion: (id, answers) => run(replyQuestion(id, answers)),
    rejectQuestion: id => run(reply("question", id, (api, sessionID) => api.cancelForm(sessionID, id))),
    dismissForm: id => run(dismissForm(id)),
    clearError: () => publish({ error: undefined }),
    hold(reason) {
      check();
      if (!reason.trim()) throw new ChatError({ message: "A hold needs a reason" });
      const blocker = holdBlocker(state);
      if (blocker) throw new ChatError({ message: `Chat cannot be held for "${reason}": ${blocker}` });
      // The snapshot is the lease: exclusive because a held chat blocks hold().
      publish({ held: reason });
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          publish({ held: undefined });
        },
      };
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      generation++;
      // Closing the root scope interrupts and joins streams, timers and requests.
      // ManagedRuntime then releases the official client's service layer.
      const joinedReaders = readers.close();
      void joinedReaders.catch(() => {});
      disposal = (async () => {
        try {
          await Effect.runPromise(Scope.close(lifetime, Exit.void));
        } finally {
          try { await joinedReaders; }
          finally { await runtime.dispose(); }
        }
      })();
      // Existing UI cleanup callers may ignore the promise; awaiters still see failure.
      void disposal.catch(() => {});
      if (state.sessionID) reducer.clear(state.sessionID);
      listeners.clear();
      return disposal;
    },
  };
  Object.defineProperty(controller, "ready", {
    value: run(reconnect(), lifetime),
    enumerable: true,
  });
  void controller.ready.catch(() => {});
  return controller;
}

const validateAnswers = Effect.fn("Chat.validateAnswers")(function*(
  request: QuestionRequest | undefined,
  answers: QuestionAnswers,
) {
  if (!request) return yield* new ChatError({ message: "Question is no longer pending" });
  if (answers.length !== request.questions.length)
    return yield* new ChatError({ message: "Answer every question" });
  for (const [i, question] of request.questions.entries()) {
    const answer = answers[i]!;
    if (
      !answer.length ||
      answer.some((a) => !a.trim()) ||
      (!question.multiple && answer.length !== 1)
    )
      return yield* new ChatError({ message: "Choose an answer for each question" });
    if (
      question.custom === false &&
      answer.some((a) => !question.options.some((o) => o.label === a))
    )
      return yield* new ChatError({ message: "Choose one of the offered answers" });
  }
});
