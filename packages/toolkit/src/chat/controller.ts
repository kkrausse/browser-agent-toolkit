// The chat controller: what a view (or a script) drives a conversation through.
//
// It owns no protocol logic of its own. The official client makes the requests
// (./client.ts), the connection loop keeps one event stream alive (./connection.ts), the
// reducer folds events into the state (./reduce.ts), sync decides what is read and when
// (./sync.ts), and the store holds the result (./store.ts). What is here is intent: which
// session is on screen, prompts and their optimistic rows, replies, the admission rules
// (hold, pending session operations) and the flat snapshot the legacy view renders from.
import {
  isFormAlreadySettledError, isFormNotFoundError, isPermissionNotFoundError,
  type FormInfo, type ModelRef, type OpenCodeEvent, type PermissionRequest, type SessionInboxInfo, type SessionInfo,
} from '@opencode/client';
import { canSend, holdBlocker } from './admission';
import { prepareFiles, type PreparedFiles } from './attachments';
import { createClient } from './client';
import { createConnection } from './connection';
import { formAnswer, questionFromForm, validateAnswer } from './forms';
import { messageID } from './id';
import { admit, retract } from './reduce';
import { executionOf, familyOf, pendingPrompts } from './selectors';
import { createStore, emptySession, initialState, type ChatState, type Message, type SessionState } from './store';
import { createSync } from './sync';
import type {
  ChatController, ChatOptions, ChatSnapshot, FormAnswer, PromptDraft, QuestionAnswers, QuestionRequest, RequestState,
} from './types';

export { canSend };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));
const stopped = () => new DOMException('Chat controller is disposed', 'AbortError');
/** The request was answered, or withdrawn, by someone else: there is nothing left to do. */
const settledElsewhere = (error: unknown) => isPermissionNotFoundError(error) || isFormNotFoundError(error) || isFormAlreadySettledError(error);

/** Root sessions, newest first. */
function rootsOf(state: ChatState): SessionInfo[] {
  const roots: SessionInfo[] = [];
  for (const session of Object.values(state.sessions)) if (session.info && !session.info.parentID) roots.push(session.info);
  return roots.sort((a, b) => b.time.created - a.time.created || (a.id < b.id ? 1 : -1));
}
const sameItems = <A>(a: readonly A[], b: readonly A[]) => a.length === b.length && a.every((item, index) => item === b[index]);

export function createChatController(options: ChatOptions): ChatController {
  if (!options.directory?.trim()) throw new Error('Caller directory is required');
  // Observation only: an observer must never break chat.
  const diagnostic = (event: string, data?: Record<string, unknown>) => {
    try { options.onDiagnostic?.(event, data); } catch { /* observer failure */ }
  };
  const milestone = (stage: string, data?: Record<string, unknown>) => diagnostic('chat.connect', { stage, ...data });
  // Every request this client started and has not seen finish; dispose joins them.
  const requests = new Set<Promise<unknown>>();
  const track = <A>(promise: Promise<A>): Promise<A> => {
    requests.add(promise);
    void promise.then(() => requests.delete(promise), () => requests.delete(promise));
    return promise;
  };
  const lifetime = new AbortController();
  const signal = lifetime.signal;
  const handshake = options.handshakeTimeoutMs ?? 15_000;
  const client = createClient(options.endpoint, track);
  const store = createStore<ChatState>(initialState(options.sessionID));
  let disposed = false, disposal: Promise<void> | undefined;
  // The pending session operation (create, model switch). The state's flag is its shadow.
  let mutation: symbol | undefined;
  // Counts selections, so work started for one is dropped when another replaced it.
  let selection = 0;
  let draftSequence = 0;
  const draftKeys = new Map<string, string>();
  // Untitled sessions this controller created that nothing has been sent to.
  const unsent = new Set<string>();
  // `startNewSession` is honoured once, at the first choice of a session.
  let opened = !!options.sessionID;
  let choosing: Promise<void> | undefined;
  // Prompts of one session reach the server in the order they were sent.
  const chains = new Map<string, Promise<unknown>>();
  // The latest send's timeline, joined by `send`. Ids, lengths and timings only.
  let sent: { send: string; sessionID: string; at: number; event?: true; text?: true } | undefined;
  let sendSequence = 0;
  const sendStage = (timeline: NonNullable<typeof sent>, event: string, data?: Record<string, unknown>) =>
    diagnostic(event, { sessionID: timeline.sessionID, send: timeline.send, elapsedMs: Math.round(performance.now() - timeline.at), ...data });

  const check = () => { if (disposed) throw new Error('Chat controller is disposed'); };
  const patch = (change: Partial<ChatState>) => store.update(state => ({ ...state, ...change }));
  const setMutation = (token: symbol | undefined) => {
    mutation = token;
    if (store.get().sessionOperationPending !== !!token) patch({ sessionOperationPending: !!token });
  };
  const editSession = (id: string, edit: (session: SessionState) => SessionState) => store.update(state => {
    const before = state.sessions[id] ?? emptySession(id);
    const after = edit(before);
    return after === before && state.sessions[id] ? state : { ...state, sessions: { ...state.sessions, [id]: after } };
  });
  const currentSession = () => {
    const id = store.get().sessionID;
    if (!id) throw new Error('Select a session first');
    return id;
  };
  /** The public boundary: a failure is the snapshot's error as well as the rejection. */
  const run = <A>(start: () => Promise<A>): Promise<A> => {
    if (disposed) return Promise.reject(new Error('Chat controller is disposed'));
    let work: Promise<A>;
    try { work = start(); } catch (error) { return Promise.reject(asError(error)); }
    return track(work.catch(error => {
      if (!disposed) patch({ error: errorText(error) });
      throw asError(error);
    }));
  };
  function until(test: (state: ChatState) => boolean, limit: number, why: () => string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (test(store.get())) { resolve(); return; }
      const finish = (error?: Error) => {
        clearTimeout(timer);
        unsubscribe();
        signal.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve();
      };
      const aborted = () => finish(new Error('Chat controller is disposed'));
      const unsubscribe = store.subscribe(() => { if (test(store.get())) finish(); });
      const timer = setTimeout(() => finish(new Error(why())), limit);
      signal.addEventListener('abort', aborted, { once: true });
    });
  }

  // ---- events ---------------------------------------------------------------

  function onBatch(touched: ReadonlySet<string>, events: readonly OpenCodeEvent[]) {
    const state = store.get();
    // An interrupt is over when its session stopped.
    if (state.interrupting.some(id => state.sessions[id]?.status !== 'running'))
      patch({ interrupting: state.interrupting.filter(id => state.sessions[id]?.status === 'running') });
    // An answer's failure is forgotten with the request it was for.
    const replied = Object.keys(state.replies);
    if (replied.length) {
      const pending = new Set<string>();
      for (const session of Object.values(state.sessions)) {
        for (const request of session.permissions) pending.add(request.id);
        for (const form of session.forms) pending.add(form.id);
      }
      if (replied.some(id => !pending.has(id) && !state.replies[id]!.submitting))
        patch({ replies: Object.fromEntries(Object.entries(state.replies).filter(([id, reply]) => pending.has(id) || reply.submitting)) });
    }
    const timeline = sent;
    if (!timeline || (timeline.event && timeline.text) || !touched.has(timeline.sessionID)) return;
    for (const event of events) {
      const data = (event as { data?: { sessionID?: unknown; assistantMessageID?: unknown } }).data;
      if (data?.sessionID !== timeline.sessionID || typeof data.assistantMessageID !== 'string') continue;
      if (!timeline.event) {
        timeline.event = true;
        sendStage(timeline, 'chat.reply.first-event', { type: event.type });
      }
      if (!timeline.text && event.type === 'session.text.delta') {
        timeline.text = true;
        sendStage(timeline, 'chat.reply.first-text');
      }
    }
  }

  const sync = createSync({
    client, store, directory: options.directory, pageSize: options.pageSize ?? 50, onBatch,
    onError: error => { if (!disposed) patch({ error: errorText(error) }); },
  });
  const connection = createConnection(client, {
    ...options.connection,
    firstConnectTimeout: handshake,
    onEvents: sync.events,
    onState(next) {
      if (disposed) return;
      store.batch(() => {
        if (next.status !== 'connected') {
          sync.offline();
          // What was asked of the old connection's server state is unknown now.
          if (store.get().interrupting.length) patch({ interrupting: [] });
        }
        patch({ connection: next });
      });
      if (next.status === 'connected') milestone('handshake');
    },
  });
  // The catalog arrives on every connection; a session is chosen when none is selected.
  store.select(state => state.ready && state.connection.status === 'connected', ready => {
    if (!ready || disposed) return;
    const state = store.get();
    milestone('catalog', { sessions: rootsOf(state).length, models: state.models.length });
    void choose().catch(error => { if (!disposed) patch({ error: errorText(error) }); });
  });

  // ---- sessions -------------------------------------------------------------

  // Selection is user intent, not asynchronous request work: the state changes before the
  // call returns, so the next input event cannot address the old draft. The returned
  // promise is the first read of the new selection's transcript.
  function select(id: string | undefined, draftKey?: string, preserveMutation = false): Promise<void> {
    check();
    selection++;
    opened = true;
    if (!preserveMutation) setMutation(undefined);
    store.batch(() => {
      patch({ sessionID: id, draftKey: draftKey ?? (id ? draftKeys.get(id) ?? `session:${id}` : undefined) });
      sync.unwatch(id);
    });
    return id ? sync.watch(id) : Promise.resolve();
  }
  /** With the catalog read and nothing selected: the latest conversation, or a new one. */
  function choose(): Promise<void> {
    return choosing ??= (async () => {
      const state = store.get();
      if (state.sessionID || mutation) return;
      const latest = rootsOf(state)[0]?.id, at = selection;
      if (options.startNewSession && !opened) {
        // The chat an earlier open created and nobody wrote in is as new as a new one:
        // without this every open leaves one more empty session in the list.
        if (latest) await select(latest);
        if (selection !== at + (latest ? 1 : 0)) return;
        const session = latest ? store.get().sessions[latest] : undefined;
        if (!session || session.order.length || session.older) await createSession();
      }
      else if (latest) await select(latest);
      else if (options.autoCreateSession) await createSession();
      milestone('session', { messages: store.get().sessions[store.get().sessionID ?? '']?.order.length ?? 0 });
    })().finally(() => { choosing = undefined; });
  }
  function createSession(title?: string): Promise<string> {
    check();
    if (mutation) return Promise.reject(new Error('A session operation is pending'));
    const state = store.get();
    // New chat must not leave a trail of empty sessions: go back to the one already
    // created and never written to, with its draft, instead of creating another.
    const empty = title === undefined ? rootsOf(state).find(session => unsent.has(session.id))?.id : undefined;
    if (empty) return empty === state.sessionID ? Promise.resolve(empty) : select(empty).then(() => empty);
    const token = Symbol();
    // Admission is synchronous. Retry retains the uncreated draft; a new intent from a
    // real session allocates a fresh key.
    const key = !state.sessionID && state.draftKey ? state.draftKey : `new:${++draftSequence}`;
    void select(undefined, key);
    setMutation(token);
    const at = selection;
    return (async () => {
      try {
        // A custom title suppresses OpenCode's automatic first-prompt naming.
        const session = await client.session.create({ ...(title === undefined ? {} : { title }), location: { directory: options.directory } }, { signal });
        if (title === undefined) unsent.add(session.id);
        draftKeys.set(session.id, key);
        // Created here and now: it is empty, and its events are its whole transcript.
        editSession(session.id, current => ({ ...current, info: current.info ?? session, parentID: session.parentID ?? undefined, status: current.status === 'unknown' ? 'idle' : current.status, loaded: true }));
        if (!disposed && selection === at && mutation === token) await select(session.id, key, true);
        return session.id;
      } finally {
        if (mutation === token) setMutation(undefined);
      }
    })();
  }
  /** Connected, catalog read, a session chosen, its transcript here and its status known. */
  async function established() {
    await until(state => state.connection.status === 'connected' && state.ready, handshake,
      () => store.get().connection.error ?? 'OpenCode event handshake timed out');
    await choose();
    const id = store.get().sessionID;
    if (!id) return;
    if (!store.get().sessions[id]?.loaded) await sync.watch(id);
    // Whether it is running is a read of its own.
    await until(state => state.sessionID !== id || state.sessions[id]?.status !== 'unknown', handshake, () => 'The list of running sessions was not read');
  }
  function reconnect(): Promise<void> {
    check();
    setMutation(undefined);
    milestone('requested');
    patch({ error: undefined });
    connection.stop();
    void connection.start();
    return established();
  }

  // ---- prompts --------------------------------------------------------------

  function modelOf(sessionID: string) {
    const state = store.get(), ref = state.sessions[sessionID]?.info?.model ?? state.defaultModel;
    return ref ? state.models.find(model => model.id === ref.id && model.providerID === ref.providerID) : undefined;
  }
  function send(draft: PromptDraft): Promise<string> {
    const sessionID = draft.sessionID ?? currentSession();
    if (!draft.text.trim() && !draft.files?.length) throw new Error('Enter a message');
    const id = messageID(), delivery = draft.delivery ?? 'steer';
    const timeline = (sent = { send: `${Date.now().toString(36)}-${++sendSequence}`, sessionID, at: performance.now() });
    sendStage(timeline, 'chat.send.clicked', { length: draft.text.length, files: draft.files?.length ?? 0, delivery });
    // Before the request: a prompt whose response is lost may still be accepted.
    unsent.delete(sessionID);
    // Shown at once, under the id the server will keep, in the shape of the pending prompt
    // the server's answer replaces it with.
    const optimistic: SessionInboxInfo = { id, sessionID, type: 'user', payload: { text: draft.text }, delivery, time: { created: Date.now() } };
    store.batch(() => {
      patch({ sending: store.get().sending + 1, error: undefined });
      editSession(sessionID, session => ({ ...admit(session, optimistic), outbox: [...session.outbox, id] }));
    });
    const work = (chains.get(sessionID) ?? Promise.resolve()).catch(() => {}).then(async () => {
      let prepared: PreparedFiles | undefined;
      try {
        if (draft.files?.length)
          prepared = await prepareFiles(draft.files, { model: modelOf(sessionID), files: options.files, directory: options.uploadDirectory, signal });
        const admitted = await client.session.prompt({ sessionID, id, text: draft.text, delivery, ...(prepared ? { files: prepared.files } : {}) }, { signal });
        sendStage(timeline, 'chat.send.accepted');
        // Delivered already (the event came first): it is a message now, not a pending prompt.
        editSession(sessionID, session => {
          const acknowledged = { ...session, outbox: session.outbox.filter(entry => entry !== id) };
          return session.pending.some(entry => entry.id === id) ? admit(acknowledged, admitted) : acknowledged;
        });
        return id;
      } catch (error) {
        sendStage(timeline, 'chat.send.rejected', { interrupted: signal.aborted });
        await prepared?.discard();
        // Withdrawn; the caller still holds the draft.
        editSession(sessionID, session => retract(session, id));
        // The server may have taken a prompt whose answer did not arrive: read and see.
        if (!disposed && store.get().sessions[sessionID]?.loaded) void sync.reload(sessionID).catch(() => {});
        throw error;
      } finally {
        patch({ sending: Math.max(0, store.get().sending - 1) });
        if (chains.get(sessionID) === work) chains.delete(sessionID);
      }
    });
    chains.set(sessionID, work);
    return work;
  }
  async function cancelQueued(id: string, target?: string) {
    const sessionID = target ?? currentSession();
    try { await client.session.inbox.cancel({ sessionID, inboxID: id }, { signal }); }
    catch (error) {
      // Delivered, or cancelled, in the meantime: the transcript says which.
      if (store.get().sessions[sessionID]?.loaded) void sync.reload(sessionID).catch(() => {});
      throw error;
    }
    editSession(sessionID, session => retract(session, id));
  }
  async function selectModel(model: ModelRef | undefined) {
    if (!model) throw new Error('Select an explicit model; the server cannot reset a session model');
    if (mutation) throw new Error('Wait for the current operation');
    const id = currentSession(), token = Symbol();
    setMutation(token);
    try {
      // Allowed while the session runs: the server records it and the next step uses it.
      await client.session.switchModel({ sessionID: id, model }, { signal });
      editSession(id, session => session.info ? { ...session, info: { ...session.info, model } } : session);
    } finally {
      if (mutation === token) setMutation(undefined);
    }
  }
  async function interrupt(target?: string) {
    const id = target ?? currentSession();
    const drop = () => { if (store.get().interrupting.includes(id)) patch({ interrupting: store.get().interrupting.filter(entry => entry !== id) }); };
    if (!store.get().interrupting.includes(id)) patch({ interrupting: [...store.get().interrupting, id] });
    try {
      const result = await client.session.interrupt({ sessionID: id }, { signal });
      // Nothing was running, or it has stopped already: no event will say so later.
      if (!result.interrupted || store.get().sessions[id]?.status !== 'running') drop();
    } catch (error) {
      drop();
      throw error;
    }
  }

  // ---- requests -------------------------------------------------------------

  function findPermission(id: string): PermissionRequest | undefined {
    for (const session of Object.values(store.get().sessions)) {
      const found = session.permissions.find(request => request.id === id);
      if (found) return found;
    }
    return undefined;
  }
  function findForm(id: string): FormInfo | undefined {
    for (const session of Object.values(store.get().sessions)) {
      const found = session.forms.find(form => form.id === id);
      if (found) return found;
    }
    return undefined;
  }
  const setReply = (id: string, reply: { submitting: boolean; error?: string } | undefined) => store.update(state => {
    const { [id]: _previous, ...rest } = state.replies;
    return { ...state, replies: reply ? { ...rest, [id]: reply } : rest };
  });
  /** One answer at a time per request. An answer the server no longer wants (someone
   * else gave it, or the request was withdrawn) counts as given. */
  async function answer(id: string, sessionID: string, submit: () => Promise<unknown>, kind: 'permissions' | 'forms') {
    if (store.get().replies[id]?.submitting) throw new Error('Response is already submitting');
    setReply(id, { submitting: true });
    try { await submit(); }
    catch (error) {
      if (!settledElsewhere(error)) {
        setReply(id, { submitting: false, error: errorText(error) });
        throw error;
      }
    }
    store.batch(() => {
      setReply(id, undefined);
      editSession(sessionID, session => kind === 'permissions'
        ? { ...session, permissions: session.permissions.filter(request => request.id !== id) }
        : { ...session, forms: session.forms.filter(form => form.id !== id) });
    });
  }
  async function replyPermission(id: string, decision: 'once' | 'always' | 'reject') {
    const request = findPermission(id);
    if (!request) throw new Error('Request is no longer pending');
    await answer(id, request.sessionID, () => client.permission.reply({ sessionID: request.sessionID, requestID: id, decision }, { signal }), 'permissions');
  }
  async function replyForm(id: string, value: FormAnswer) {
    const form = findForm(id);
    if (!form) throw new Error('Form is no longer pending');
    const invalid = validateAnswer(form.fields, value);
    if (invalid) throw new Error(invalid);
    await answer(id, form.sessionID, () => client.session.form.reply({ sessionID: form.sessionID, formID: id, answer: value }, { signal }), 'forms');
  }
  async function cancelForm(id: string) {
    const form = findForm(id);
    if (!form) throw new Error('Form is no longer pending');
    await answer(id, form.sessionID, () => client.session.form.cancel({ sessionID: form.sessionID, formID: id }, { signal }), 'forms');
  }
  async function replyQuestion(id: string, answers: QuestionAnswers) {
    const form = findForm(id), request = form && questionFromForm(form);
    validateAnswers(request, answers);
    await replyForm(id, formAnswer(request!, answers));
  }

  // ---- the flat snapshot ------------------------------------------------------

  let snapshotOf: ChatState | undefined, snapshot: ChatSnapshot | undefined;
  let roots: readonly SessionInfo[] = [], messages: readonly Message[] = [];
  let messagesOf: { order: readonly string[]; messages: SessionState['messages'] } | undefined;
  function getSnapshot(): ChatSnapshot {
    const state = store.get();
    if (snapshot && snapshotOf === state) return snapshot;
    const id = state.sessionID, session = id ? state.sessions[id] : undefined;
    const nextRoots = rootsOf(state);
    if (!sameItems(roots, nextRoots)) roots = nextRoots;
    if (!session) { messages = messages.length ? [] : messages; messagesOf = undefined; }
    else if (messagesOf?.order !== session.order || messagesOf.messages !== session.messages) {
      messages = session.order.flatMap(key => { const message = session.messages[key]; return message ? [message] : []; });
      messagesOf = { order: session.order, messages: session.messages };
    }
    const family = id ? familyOf(state, id) : [];
    const requestState = <T extends { id: string }>(request: T): RequestState<T> => {
      const reply = state.replies[request.id];
      return { request, submitting: reply?.submitting ?? false, ...(reply?.error ? { error: reply.error } : {}) };
    };
    const forms = [...family, 'global'].flatMap(key => state.sessions[key]?.forms ?? []);
    const questions: RequestState<QuestionRequest>[] = [], unsupportedForms: FormInfo[] = [];
    for (const form of forms) {
      const question = questionFromForm(form);
      if (question) questions.push(requestState(question));
      else unsupportedForms.push(form);
    }
    snapshotOf = state;
    return snapshot = {
      connection: state.connection.status === 'connected' ? 'connected' : state.connection.status === 'stopped' ? 'disconnected' : 'connecting',
      connectionState: state.connection,
      sessionID: id,
      sessions: roots,
      draftKey: state.draftKey,
      sessionOperationPending: state.sessionOperationPending,
      held: state.held,
      models: state.models,
      model: session?.info?.model,
      defaultModel: state.defaultModel,
      messages,
      execution: !id ? 'idle' : !session || state.connection.status !== 'connected' ? 'unknown' : executionOf(session),
      failure: session?.failure,
      interruptRequested: !!id && state.interrupting.includes(id),
      sending: state.sending > 0,
      loading: id ? !session?.loaded : !state.ready || state.sessionOperationPending,
      loadingOlder: session?.loadingOlder ?? false,
      hasOlder: !!session?.older,
      pending: pendingPrompts(session),
      permissions: family.flatMap(key => state.sessions[key]?.permissions ?? []).map(requestState),
      forms: forms.map(requestState),
      questions,
      unsupportedForms,
      error: state.error,
    };
  }

  // A hold freezes new intent at the public boundary. The choice of a session at
  // connection is internal and not routed through here; replies and interrupt stay available.
  const unheld = <A>(intent: () => Promise<A>): Promise<A> => {
    const held = store.get().held;
    return held && !disposed ? Promise.reject(new Error(`Chat is held: ${held}`)) : intent();
  };
  const controller: ChatController = {
    ready: undefined as unknown as Promise<void>,
    store,
    getSnapshot,
    subscribe(notify) {
      check();
      return store.subscribe(notify);
    },
    selectSession: id => unheld(() => run(() => select(id))),
    reconnect: () => unheld(() => run(reconnect)),
    createSession: title => unheld(() => run(() => createSession(title))),
    loadOlder: id => run(() => sync.loadOlder(id ?? currentSession())),
    loadSession: id => run(() => sync.watch(id)),
    send: draft => unheld(() => {
      // A rejected intent is not a chat error, and must never become a queued send
      // merely because readiness changes before the request starts.
      if (!disposed) {
        const state = store.get();
        const ready = draft.sessionID && draft.sessionID !== state.sessionID
          ? state.connection.status === 'connected' && !state.held : canSend(getSnapshot());
        if (!ready) return Promise.reject(new Error('Chat is not ready to send'));
      }
      return run(() => send(draft));
    }),
    cancelQueued: (id, sessionID) => run(() => cancelQueued(id, sessionID)),
    selectModel: model => unheld(() => run(() => selectModel(model))),
    interrupt: id => run(() => interrupt(id)),
    replyPermission: (id, decision) => run(() => replyPermission(id, decision)),
    replyForm: (id, value) => {
      // An answer the form does not take is the caller's to show beside the form, not a chat error.
      const form = disposed ? undefined : findForm(id), invalid = form && validateAnswer(form.fields, value);
      return invalid ? Promise.reject(new Error(invalid)) : run(() => replyForm(id, value));
    },
    cancelForm: id => run(() => cancelForm(id)),
    replyQuestion: (id, answers) => run(() => replyQuestion(id, answers)),
    rejectQuestion: id => run(() => cancelForm(id)),
    dismissForm: id => run(() => cancelForm(id)),
    clearError: () => { if (store.get().error !== undefined) patch({ error: undefined }); },
    hold(reason) {
      check();
      if (!reason.trim()) throw new Error('A hold needs a reason');
      const blocker = holdBlocker(getSnapshot());
      if (blocker) throw new Error(`Chat cannot be held for "${reason}": ${blocker}`);
      // The state is the lease: exclusive because a held chat blocks hold().
      patch({ held: reason });
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          patch({ held: undefined });
        },
      };
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      lifetime.abort(stopped());
      sync.dispose();
      const closing = connection.dispose();
      store.close();
      // Aborted requests and the event reader settle on their own; wait for them so a
      // caller that closes the runtime next does not race open connections.
      disposal = (async () => {
        await closing;
        while (requests.size) await Promise.allSettled([...requests]);
      })();
      return disposal;
    },
  };
  milestone('requested');
  if (options.sessionID) void sync.watch(options.sessionID);
  void connection.start();
  Object.defineProperty(controller, 'ready', { value: run(established), enumerable: true });
  void controller.ready.catch(() => {});
  return controller;
}

function validateAnswers(request: QuestionRequest | undefined, answers: QuestionAnswers): asserts request {
  if (!request) throw new Error('Question is no longer pending');
  if (answers.length !== request.questions.length) throw new Error('Answer every question');
  for (const [index, question] of request.questions.entries()) {
    const answer = answers[index]!;
    if (!answer.length || answer.some(value => !value.trim()) || (!question.multiple && answer.length !== 1))
      throw new Error('Choose an answer for each question');
    if (question.custom === false && answer.some(value => !question.options.some(option => option.label === value)))
      throw new Error('Choose one of the offered answers');
  }
}
