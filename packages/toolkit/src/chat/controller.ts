import { createChatAPI, type ChatAPI, type NativeEvent } from "./api";
import { createV2SessionReducer } from "./vendor/reducer";
import { questionFromForm, formAnswer } from "./forms";
import { canSend, holdBlocker } from "./admission";
import type { ChatController, ChatOptions, ChatSnapshot, ModelRef, QuestionRequest, QuestionAnswers } from "./types";

export { canSend };

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));
type Message = ChatSnapshot["messages"][number];
/** A sent message shown before the server has it, under a local id. `before` is the
 * transcript the send started from. */
interface Provisional { id: string; text: string; before: readonly Message[]; inboxID?: string; delivered?: true }
const isProvisional = (message: Message) => message.id.startsWith("provisional:");
/** Text deltas are not persisted: a history snapshot taken mid-stream carries a
 * streaming part with less text than the events already delivered. A refresh keeps
 * the delivered text there, so what is on screen never shrinks. */
function keepStreamed(snapshot: Message, shown: Message | undefined): Message {
  if (snapshot.type !== "assistant" || shown?.type !== "assistant" || snapshot.time.completed) return snapshot;
  return {
    ...snapshot,
    content: snapshot.content.map((part, i) => {
      const live = shown.content[i];
      return (part.type === "text" || part.type === "reasoning") && live?.type === part.type &&
        live.text.length > part.text.length && live.text.startsWith(part.text)
        ? { ...part, text: live.text } : part;
    }),
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}
/** A nested abort scope: aborting the parent aborts the child. */
function child(parent: AbortController): AbortController {
  const scope = new AbortController();
  if (parent.signal.aborted) scope.abort(parent.signal.reason);
  else parent.signal.addEventListener("abort", () => scope.abort(parent.signal.reason), { once: true, signal: scope.signal });
  return scope;
}
const stopped = () => new DOMException("Chat request was superseded", "AbortError");

/**
 * Owns only its local state and injected HTTP requests. Creation never creates a session
 * by default. Three nested abort scopes own all request work: the controller's lifetime,
 * the current event connection, and the current session selection. Results that arrive
 * for a superseded connection or selection are dropped (`valid`).
 */
export function createChatController(options: ChatOptions): ChatController {
  if (!options.directory?.trim()) throw new Error("Caller directory is required");
  // Observation only: an observer must never break chat.
  const diagnostic = (event: string, data?: Record<string, unknown>) => {
    try { options.onDiagnostic?.(event, data); } catch { /* observer failure */ }
  };
  // Everything this client started and has not seen finish; dispose joins it.
  const pending = new Set<Promise<unknown>>();
  const track = <A>(promise: Promise<A>): Promise<A> => {
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  };
  const api: ChatAPI = createChatAPI({ fetch: (path, init) => track(options.endpoint.fetch(path, init)) }, options.directory);
  const lifetime = new AbortController();
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
  let disposed = false, generation = 0, selection = 0, revision = 0;
  let connection = child(lifetime), selectionScope = child(connection);
  let older: string | undefined | null, hydration: Promise<void> | undefined;
  // The first page of this selection has been walked back to the start of history.
  let reachedStart = false;
  let requestEvents: NativeEvent[] = [];
  // While a history request is in flight: messages changed by live events, and
  // whether a refresh was asked for that this request may be too old to satisfy.
  const live = new Set<string>();
  let stale = false;
  let provisional: Provisional[] = [];
  // Deliveries seen while a prompt response is outstanding: its inbox id is not known yet.
  const deliveredEarly = new Set<string>();
  const answered = new Set<string>();
  const dismissing = new Set<string>();
  let recovery: ReturnType<typeof setTimeout> | undefined;
  let settling: symbol | undefined;
  let mutation: symbol | undefined;
  let draftSequence = 0;
  const draftKeys = new Map<string, string>();
  // Untitled sessions this controller created that nothing has been sent to.
  const unsent = new Set<string>();
  let disposal: Promise<void> | undefined;
  // The latest send's timeline, joined by `send`. Ids, lengths and timings only.
  let sent: { send: string; sessionID: string; at: number; event?: true; text?: true } | undefined;
  let sendSequence = 0;
  const sendStage = (timeline: NonNullable<typeof sent>, event: string, data?: Record<string, unknown>) =>
    diagnostic(event, { sessionID: timeline.sessionID, send: timeline.send, elapsedMs: Math.round(performance.now() - timeline.at), ...data });
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
  const currentSession = () => {
    if (!state.sessionID) throw new Error("Select a session first");
    return state.sessionID;
  };
  const valid = (g: number, s: number) => !disposed && g === generation && s === selection;
  /** Background work: its failure is published, unless it was superseded. */
  const background = (work: Promise<unknown>, g: number, s: number, signal: AbortSignal) =>
    void track(work.catch(error => {
      if (valid(g, s) && !signal.aborted) publish({ error: errorText(error) });
    }));
  /** The public boundary. `start` runs its synchronous admission immediately; a failure
   * of the selection it leaves in place is published as the snapshot error. */
  const run = <A>(start: () => Promise<A>): Promise<A> => {
    if (disposed) return Promise.reject(new Error("Chat controller is disposed"));
    let work: Promise<A>;
    try { work = start(); } catch (error) { return Promise.reject(asError(error)); }
    const g = generation, s = selection, signal = selectionScope.signal;
    return track(work.catch(error => {
      if (valid(g, s) && !signal.aborted) publish({ error: errorText(error) });
      throw asError(error);
    }));
  };
  function recover() {
    if (hydration) stale = true;
    if (disposed || recovery || state.connection !== "connected") return;
    const g = generation, s = selection, signal = selectionScope.signal;
    recovery = setTimeout(() => {
      recovery = undefined;
      if (valid(g, s) && !signal.aborted) background(hydrate(), g, s, signal);
    }, 120);
  }
  // A finished run's last content and its idle row only arrive with a history
  // refresh. Idle is published after that refresh, so the chat never reads Ready
  // before the answer is in the transcript. The event stays authoritative: idle
  // follows even when the refresh fails, unless a newer run started meanwhile.
  function settle() {
    if (disposed) return;
    const g = generation, s = selection, signal = selectionScope.signal, token = (settling = Symbol());
    background((async () => {
      try {
        // A request already in flight may predate the end of the run.
        if (hydration) await hydration.catch(() => {});
        await hydrate();
      } finally {
        if (valid(g, s) && settling === token) {
          settling = undefined;
          publish({ execution: "idle", interruptRequested: false });
        }
      }
    })(), g, s, signal);
  }
  /** One history refresh at a time; a second caller joins the one in flight. */
  function hydrate(): Promise<void> {
    if (hydration) return hydration;
    if (!state.sessionID) return Promise.resolve();
    const g = generation, s = selection, rev = revision, id = state.sessionID, signal = selectionScope.signal;
    requestEvents = [];
    live.clear();
    stale = false;
    const delivered = new Set(provisional.filter((p) => p.delivered).map((p) => p.id));
    const task: Promise<void> = (async () => {
      const [page, permissions, forms, active] = await Promise.all([
        api.messages(id, { order: "desc", limit: options.pageSize ?? 50 }, signal),
        api.permissions(id, signal), api.forms(id, signal), api.active(signal),
      ]);
      if (!valid(g, s)) return;
      // HTTP snapshots have no shared SSE cursor. Never replay overlapping deltas:
      // they may already be persisted. Refetch after the overlap instead.
      const messages = [...page.data].reverse();
      const ids = new Set(messages.map((m) => m.id));
      // A provisional message gives way to this page when the page holds its persisted
      // message: the one under its inbox id if the server kept that id, otherwise a
      // user message with the same text that the transcript did not have when the send
      // began (the persisted id need not be the inbox id, and carries no reference to
      // it). A page requested after `session.inbox.delivered` named its inbox id is
      // authoritative either way. Until then it stays, below everything in the page;
      // its client-clock timestamp never makes it older history.
      const claimed = new Set<string>();
      provisional = provisional.filter((p) => {
        const persisted = messages.find((m) => m.type === "user" && !claimed.has(m.id) &&
          (m.id === p.inboxID || (m.text === p.text && !p.before.some((b) => b.id === m.id))));
        if (persisted) claimed.add(persisted.id);
        return !persisted && !delivered.has(p.id);
      });
      const unsettled = new Set(provisional.map((p) => p.id));
      const prefix = state.messages.filter((m) => !ids.has(m.id) && !isProvisional(m));
      const first = messages[0]?.time.created ?? 0;
      const previous = prefix.filter((m) => m.time.created < first);
      // The server returns a cursor for every non-empty page. Once the start of
      // history is known, a refresh has nothing older to look for.
      if (!previous.length && !reachedStart) older = page.cursor.next;
      // Events kept arriving while this page was in flight and it may predate them:
      // a message they changed, or created, stays as the events left it.
      const shown = new Map(state.messages.map((m) => [m.id, m]));
      publish({
        messages: [
          ...previous,
          ...messages.map((m) => (live.has(m.id) && shown.get(m.id)) || keepStreamed(m, shown.get(m.id))),
          // In the order shown: a reply that began streaming stays below its prompt.
          ...state.messages.filter((m) => unsettled.has(m.id) ||
            (live.has(m.id) && prefix.includes(m) && !previous.includes(m))),
        ],
        hasOlder: !!older,
        permissions: permissions
          .filter((r) => !answered.has(`permission:${r.id}`))
          .map((request) => ({ submitting: false, ...state.permissions.find((p) => p.request.id === request.id), request })),
        unsupportedForms: forms.filter(f => !answered.has(`question:${f.id}`) && !questionFromForm(f)),
        questions: forms.flatMap(f => { const q = questionFromForm(f); return q ? [q] : []; })
          .filter((r) => !answered.has(`question:${r.id}`))
          .map((request) => ({ submitting: false, ...state.questions.find((p) => p.request.id === request.id), request })),
        // Events own a known execution state; an unknown one has nothing to protect.
        ...(revision === rev || state.execution === "unknown"
          ? { execution: active[id] ? ("running" as const) : ("idle" as const), ...(!active[id] ? { interruptRequested: false } : {}) }
          : {}),
        loading: false,
      });
      if (older) {
        publish({ loadingOlder: true });
        try { await drainOlder(g, s, signal); }
        finally { if (valid(g, s)) publish({ loadingOlder: false }); }
      }
      reachedStart = !older;
      for (const e of requestEvents) requestEvent(e);
      if (stale) recover();
    })();
    const joined = task.finally(() => {
      if (hydration === joined) hydration = undefined;
    });
    void joined.catch(() => {});
    hydration = joined;
    return joined;
  }
  function requestEvent(e: NativeEvent) {
    if (e.type === "permission.asked")
      publish({ permissions: [...state.permissions.filter((p) => p.request.id !== e.data.id), { request: e.data, submitting: false }] });
    if (e.type === "form.created") {
      const form = e.data.form;
      const request = questionFromForm(form);
      if (answered.has(`question:${form.id}`)) return;
      if (request) publish({ questions: [...state.questions.filter((p) => p.request.id !== form.id), { request, submitting: false }] });
      else publish({ unsupportedForms: [...state.unsupportedForms.filter(f => f.id !== form.id), form] });
    }
    if (e.type === "permission.replied") {
      answered.add(`permission:${e.data.requestID}`);
      publish({ permissions: state.permissions.filter((p) => p.request.id !== e.data.requestID) });
    }
    if (e.type === "form.replied" || e.type === "form.cancelled") {
      answered.add(`question:${e.data.id}`);
      publish({
        unsupportedForms: state.unsupportedForms.filter(f => f.id !== e.data.id),
        questions: state.questions.filter((p) => p.request.id !== e.data.id),
      });
    }
  }
  function event(e: NativeEvent) {
    if (e.type === "session.renamed") {
      publish({ sessions: state.sessions.map(session => session.id === e.data.sessionID ? { ...session, title: e.data.title } : session) });
      return;
    }
    const sessionID = e.type === "form.created" ? e.data.form.sessionID :
      "sessionID" in e.data ? e.data.sessionID : undefined;
    if (!sessionID || sessionID !== state.sessionID) return;
    revision++;
    requestEvent(e);
    if (hydration && /^(permission|form)\./.test(e.type)) requestEvents.push(e);
    if (e.type === "session.execution.started") {
      settling = undefined;
      publish({ execution: "running" });
    }
    if (e.type === "session.retry.scheduled") {
      settling = undefined;
      publish({ execution: "retrying" });
    }
    if (e.type === "session.status") {
      if (e.data.status.type === "idle") settle();
      else {
        settling = undefined;
        publish({ execution: e.data.status.type === "retry" ? "retrying" : "running" });
      }
    }
    if (e.type === "session.model.selected") publish({ model: e.data.model });
    if (e.type === "session.inbox.delivered") {
      const entry = provisional.find((p) => p.inboxID === e.data.inboxID);
      if (entry) entry.delivered = true;
      else if (provisional.some((p) => !p.inboxID)) deliveredEarly.add(e.data.inboxID);
    }
    if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(e.type)) {
      if ("error" in e.data) publish({ error: errorText(JSON.stringify(e.data.error)) });
      settle();
    }
    const before = state.messages;
    const reduced = reducer.reduce(before, e);
    if (reduced?.touched.length) publish({ messages: reduced.messages });
    const timeline = sent?.sessionID === sessionID ? sent : undefined;
    if (timeline && !timeline.event && "assistantMessageID" in e.data) {
      timeline.event = true;
      sendStage(timeline, "chat.reply.first-event", { type: e.type });
    }
    if (timeline && !timeline.text && e.type === "session.text.delta" && reduced?.touched.length) {
      timeline.text = true;
      sendStage(timeline, "chat.reply.first-text");
    }
    // Events are never held back for a history request: a long answer keeps
    // streaming. What an event changed outlives the page in flight; an event that
    // changed nothing here is covered by a refresh after it.
    if (hydration) {
      if (reduced?.touched.length) for (const id of reduced.touched) live.add(id);
      else recover();
    }
    if (reduced && "assistantMessageID" in e.data && /\.(delta|success|failed)$/.test(e.type)) {
      const id = e.data.assistantMessageID,
        old = before.find((m) => m.id === id),
        next = reduced.messages.find((m) => m.id === id);
      if (old?.type === "assistant" && next?.type === "assistant" && old.content.every((p, i) => next.content[i] === p)) recover();
    }
    if (reduced?.missing || (reduced && !reduced.touched.length && "assistantMessageID" in e.data)) recover();
    if (e.type === "session.inbox.delivered" || e.type === "session.instructions.updated" ||
        e.type === "session.moved" || e.type === "session.model.selected") recover();
    if (/^session\.(text|reasoning|tool\.input)\.ended$/.test(e.type) || e.type === "session.step.ended") recover();
  }
  // Selection is user intent, not asynchronous request work. Publish before the
  // public call returns, so the next input event cannot address the old draft.
  // The returned promise is the first history load of the new selection.
  function selectSession(id: string | undefined, draftKey?: string, preserveMutation = false): Promise<void> {
    check();
    const previous = selectionScope;
    selectionScope = child(connection);
    selection++;
    hydration = undefined;
    if (!preserveMutation) mutation = undefined;
    clearTimeout(recovery);
    recovery = undefined;
    if (state.sessionID) reducer.clear(state.sessionID);
    answered.clear();
    provisional = [];
    deliveredEarly.clear();
    older = undefined;
    reachedStart = false;
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
    previous.abort(stopped());
    const g = generation, s = selection;
    return hydrate().finally(() => {
      if (valid(g, s)) publish({ loading: false });
    });
  }
  async function reconnect(): Promise<void> {
    check();
    generation++;
    const previous = connection;
    connection = child(lifetime);
    selectionScope = child(connection);
    mutation = undefined;
    hydration = undefined;
    clearTimeout(recovery);
    recovery = undefined;
    const g = generation, scope = connection, selectionAtStart = selection;
    // Milestones for stage timing; observation only.
    const milestone = (stage: string, data?: Record<string, unknown>) => diagnostic("chat.connect", { stage, ...data });
    milestone("requested");
    if (state.sessionID) reducer.clear(state.sessionID);
    // A send cut off by the reconnect is not known to be accepted; history decides.
    provisional = [];
    deliveredEarly.clear();
    publish({
      connection: "connecting",
      messages: state.messages.filter((m) => !isProvisional(m)),
      loading: true,
      error: undefined,
      execution: "unknown",
      sending: false,
    });
    previous.abort(stopped());
    try {
      let connected!: () => void, failed!: (error: unknown) => void;
      const marker = new Promise<void>((resolve, reject) => { connected = resolve; failed = reject; });
      void marker.catch(() => {});
      void track((async () => {
        try {
          for await (const e of api.events(scope.signal)) {
            if (g !== generation || disposed) return;
            if (e.type === "server.connected") connected();
            event(e);
          }
          throw new Error("OpenCode event connection closed. Reconnect to reload history.");
        } catch (error) {
          failed(error);
          if (g !== generation || disposed || scope.signal.aborted) return;
          publish({ connection: "disconnected", execution: "unknown", loading: false, error: errorText(error) });
          scope.abort(stopped());
        }
      })());
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([marker, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("OpenCode event handshake timed out")), options.handshakeTimeoutMs ?? 15000);
      })]).finally(() => clearTimeout(timer));
      milestone("handshake");
      const [sessions, models] = await Promise.all([api.list(scope.signal), api.models(scope.signal)]);
      milestone("catalog", { sessions: sessions.length, models: models.length });
      // models() awaits plugin activation before resolving the same location's default.
      const defaultModel = await api.defaultModel(scope.signal);
      milestone("default-model");
      if (g !== generation || disposed) return;
      publish({ sessions, models, defaultModel, connection: "connected" });
      if (selection !== selectionAtStart) return;
      const id = state.sessionID ?? sessions[0]?.id;
      if (options.startNewSession && !state.sessionID) {
        // The chat an earlier open created and nobody wrote in is as new as a new one:
        // without this every open leaves one more empty session in the list.
        if (sessions[0]) await selectSession(sessions[0].id);
        if (!sessions[0] || state.messages.length || state.hasOlder) await createSession();
      }
      else if (id) await selectSession(id);
      else if (options.autoCreateSession) await createSession();
      else publish({ loading: false, execution: "idle" });
      milestone("session", { messages: state.messages.length });
    } catch (error) {
      if (g === generation && !disposed) {
        publish({ connection: "disconnected", loading: false, error: state.error ?? errorText(error) });
        scope.abort(stopped());
      }
      throw error;
    }
  }
  async function reply(kind: "permission" | "question", id: string, submit: (sessionID: string, signal: AbortSignal) => Promise<void>) {
    const list = kind === "permission" ? state.permissions : state.questions;
    const entry = list.find((p) => p.request.id === id);
    if (!entry) throw new Error("Request is no longer pending");
    if (entry.submitting) throw new Error("Response is already submitting");
    const g = generation, s = selection, signal = selectionScope.signal;
    const update = (error?: string, submitting = false, remove = false) => {
      if (!valid(g, s)) return;
      if (kind === "permission")
        publish({ permissions: state.permissions.flatMap((p) => p.request.id !== id ? [p] : remove ? [] : [{ ...p, error, submitting }]) });
      else
        publish({ questions: state.questions.flatMap((p) => p.request.id !== id ? [p] : remove ? [] : [{ ...p, error, submitting }]) });
    };
    update(undefined, true);
    try { await submit(currentSession(), signal); }
    catch (error) { update(errorText(error)); throw error; }
    if (valid(g, s)) answered.add(`${kind}:${id}`);
    update(undefined, false, true);
  }
  function createSession(title?: string): Promise<string> {
    check();
    if (mutation) return Promise.reject(new Error("A session operation is pending"));
    // New chat must not leave a trail of empty sessions: go back to the one already
    // created and never written to, with its draft, instead of creating another.
    const empty = title === undefined ? state.sessions.find(session => unsent.has(session.id))?.id : undefined;
    if (empty) return empty === state.sessionID ? Promise.resolve(empty) : selectSession(empty).then(() => empty);
    const token = (mutation = Symbol());
    // Admission is synchronous. Retry retains the uncreated draft; a new intent from a
    // real session allocates a fresh key.
    const key = !state.sessionID && state.draftKey ? state.draftKey : `new:${++draftSequence}`;
    const transition = selectSession(undefined, key, true);
    const g = generation, s = selection, signal = selectionScope.signal;
    return (async () => {
      try {
        await transition;
        if (!valid(g, s) || mutation !== token) throw new Error("Session creation was abandoned");
        // A custom title suppresses OpenCode's automatic first-prompt naming.
        const session = await api.create(title, signal);
        if (title === undefined) unsent.add(session.id);
        if (valid(g, s)) {
          draftKeys.set(session.id, key);
          publish({ sessions: [session, ...state.sessions] });
          await selectSession(session.id, key, true);
        }
        return session.id;
      } finally {
        if (mutation === token) {
          mutation = undefined;
          publish({ loading: false });
        }
      }
    })();
  }
  async function drainOlder(g: number, s: number, signal: AbortSignal) {
    const cursors = new Set<string>();
    while (older && valid(g, s)) {
      const cursor = older;
      cursors.add(cursor);
      const page = await api.messages(currentSession(), { cursor, limit: options.pageSize ?? 50 }, signal);
      if (!valid(g, s)) return;
      if (page.cursor.next && cursors.has(page.cursor.next)) {
        older = undefined;
        publish({ hasOlder: false });
        throw new Error("Repeated history cursor");
      }
      older = page.cursor.next;
      const ids = new Set(state.messages.map((m) => m.id));
      publish({
        messages: [...page.data].reverse().filter((m) => !ids.has(m.id)).concat([...state.messages]),
        hasOlder: !!older,
      });
    }
  }
  async function loadOlder() {
    if (!older || state.loadingOlder || hydration) return;
    const g = generation, s = selection, signal = selectionScope.signal;
    publish({ loadingOlder: true });
    try { await drainOlder(g, s, signal); }
    finally { if (valid(g, s)) publish({ loadingOlder: false }); }
  }
  async function send(draft: { text: string }) {
    if (!draft.text.trim()) throw new Error("Enter a message");
    if (!canSend(state)) throw new Error("Chat is not ready to send");
    const g = generation, s = selection, id = currentSession(), signal = selectionScope.signal;
    const timeline = (sent = { send: `${Date.now().toString(36)}-${++sendSequence}`, sessionID: id, at: performance.now() });
    sendStage(timeline, "chat.send.clicked", { length: draft.text.length });
    // Shown at once, in the shape of the persisted user message that replaces it.
    const entry: Provisional = { id: `provisional:${timeline.send}`, text: draft.text, before: state.messages };
    provisional.push(entry);
    publish({
      sending: true,
      error: undefined,
      messages: [...state.messages, { id: entry.id, type: "user", text: draft.text, time: { created: Date.now() } }],
    });
    try {
      // Before the request: a prompt whose response is lost may still be accepted.
      unsent.delete(id);
      const inbox = await api.prompt(id, draft.text, signal).catch(error => {
        sendStage(timeline, "chat.send.rejected", { interrupted: signal.aborted });
        // Withdrawn; the caller still holds the text. A changed selection already dropped it.
        provisional = provisional.filter((p) => p !== entry);
        if (state.messages.some((m) => m.id === entry.id)) publish({ messages: state.messages.filter((m) => m.id !== entry.id) });
        throw error;
      });
      sendStage(timeline, "chat.send.accepted");
      entry.inboxID = inbox.id;
      if (deliveredEarly.has(inbox.id)) entry.delivered = true;
      deliveredEarly.clear();
      if (valid(g, s)) {
        await hydrate().catch(error => {
          // Prompt acceptance is known. A refresh failure must not invite a
          // duplicate submission of an already accepted prompt.
          if (valid(g, s)) publish({ error: `Message accepted; refresh failed: ${errorText(error)}`, execution: "unknown" });
        });
      }
    } finally {
      if (valid(g, s)) publish({ sending: false });
    }
  }
  async function selectModel(model: ModelRef | undefined) {
    if (!model) throw new Error("Select an explicit model; the pinned API cannot reset a session model");
    if (state.execution !== "idle" || mutation || state.sending || state.held) throw new Error("Wait for the current operation");
    const id = currentSession();
    const g = generation, s = selection, signal = selectionScope.signal, token = (mutation = Symbol());
    publish({}); // republishes the derived pending flag
    try {
      await api.model(id, model, signal);
      if (valid(g, s)) publish({ model, sessions: state.sessions.map(session => session.id === id ? { ...session, model } : session) });
    } finally {
      if (mutation === token) {
        mutation = undefined;
        publish({});
      }
    }
  }
  async function interrupt() {
    const id = currentSession(), g = generation, s = selection, signal = selectionScope.signal;
    publish({ interruptRequested: true });
    await api.interrupt(id, signal);
    if (valid(g, s)) await hydrate();
  }
  async function replyQuestion(id: string, answers: QuestionAnswers) {
    const request = state.questions.find(q => q.request.id === id)?.request;
    validateAnswers(request, answers);
    await reply("question", id, (sessionID, signal) => api.replyForm(sessionID, id, formAnswer(request!, answers), signal));
  }
  // Unsupported forms have no reply the question UI can express. Cancelling
  // is the only answer this client can give, and it unblocks the session.
  async function dismissForm(id: string) {
    if (!state.unsupportedForms.some(f => f.id === id)) throw new Error("Form is no longer pending");
    if (dismissing.has(id)) throw new Error("Response is already submitting");
    const g = generation, s = selection, signal = selectionScope.signal, session = currentSession();
    dismissing.add(id);
    try { await api.cancelForm(session, id, signal); }
    finally { dismissing.delete(id); }
    if (!valid(g, s)) return;
    answered.add(`question:${id}`);
    publish({ unsupportedForms: state.unsupportedForms.filter(f => f.id !== id) });
  }
  // A hold freezes new intent at the public boundary. Bootstrap selection is
  // internal and not routed through here; replies and interrupt stay available.
  const unheld = <A>(intent: () => Promise<A>): Promise<A> =>
    state.held && !disposed ? Promise.reject(new Error(`Chat is held: ${state.held}`)) : intent();
  const controller: ChatController = {
    ready: undefined as unknown as Promise<void>,
    getSnapshot: () => state,
    subscribe(notify) {
      check();
      listeners.add(notify);
      return () => { listeners.delete(notify); };
    },
    selectSession: id => unheld(() => run(() => selectSession(id))),
    reconnect: () => unheld(() => run(reconnect)),
    createSession: title => unheld(() => run(() => createSession(title))),
    loadOlder: () => run(loadOlder),
    send: draft => unheld(() => {
      // A rejected intent is not a chat error, and must never become a queued send
      // merely because readiness changes before the request starts.
      if (!disposed && !canSend(state)) return Promise.reject(new Error("Chat is not ready to send"));
      return run(() => send(draft));
    }),
    selectModel: model => unheld(() => run(() => selectModel(model))),
    interrupt: () => run(interrupt),
    replyPermission: (id, decision) => run(() => reply("permission", id, (sessionID, signal) => api.replyPermission(sessionID, id, decision, signal))),
    replyQuestion: (id, answers) => run(() => replyQuestion(id, answers)),
    rejectQuestion: id => run(() => reply("question", id, (sessionID, signal) => api.cancelForm(sessionID, id, signal))),
    dismissForm: id => run(() => dismissForm(id)),
    clearError: () => publish({ error: undefined }),
    hold(reason) {
      check();
      if (!reason.trim()) throw new Error("A hold needs a reason");
      const blocker = holdBlocker(state);
      if (blocker) throw new Error(`Chat cannot be held for "${reason}": ${blocker}`);
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
      clearTimeout(recovery);
      lifetime.abort(stopped());
      if (state.sessionID) reducer.clear(state.sessionID);
      listeners.clear();
      // Aborted requests and the event reader settle on their own; wait for them so a
      // caller that closes the runtime next does not race open connections.
      disposal = (async () => {
        while (pending.size) await Promise.allSettled([...pending]);
      })();
      return disposal;
    },
  };
  Object.defineProperty(controller, "ready", { value: run(reconnect), enumerable: true });
  void controller.ready.catch(() => {});
  return controller;
}

function validateAnswers(request: QuestionRequest | undefined, answers: QuestionAnswers) {
  if (!request) throw new Error("Question is no longer pending");
  if (answers.length !== request.questions.length) throw new Error("Answer every question");
  for (const [i, question] of request.questions.entries()) {
    const answer = answers[i]!;
    if (!answer.length || answer.some((a) => !a.trim()) || (!question.multiple && answer.length !== 1))
      throw new Error("Choose an answer for each question");
    if (question.custom === false && answer.some((a) => !question.options.some((o) => o.label === a)))
      throw new Error("Choose one of the offered answers");
  }
}
