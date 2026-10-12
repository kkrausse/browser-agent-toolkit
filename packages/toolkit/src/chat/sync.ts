// Reads, and the rule for when to read again.
//
// The event stream has no replay, so state is recovered by reading. The reads here are:
// the list of running sessions, the catalog (root sessions, models, the default model), a
// session's transcript (its inbox, the latest page of messages, permissions, forms, its
// info), a session's children, and older pages on demand. Nothing else is read: a
// transcript is not read again because a part ended or a prompt was sent.
//
// A transcript is read again only
//   - on `server.connected` (every connection: what happened before it is unknown),
//   - when the reducer marked the session `stale`: an event named a message or tool this
//     client does not have, or a run ended and left tools
//     unfinished (the server settles those without events),
// and a session's info is read when an event names a session this client has never seen.
//
// `createKeys` is the invalidate-and-rerun rule of OpenCode 2.0.26 (`createSync` in
// `packages/client/src/solid/data.ts`, MIT, see ../../NOTICES.md): a read runs once per
// invalidation, callers join the one in flight, and an invalidation that lands while a
// read is in flight makes the next caller run it again after it, so an older response
// never commits after its replacement.
import type { ModelInfo, ModelRef, OpenCodeClient, OpenCodeEvent, SessionInfo } from '@opencode/client';
import { applySnapshot, eventSession, reduce, reduceSession } from './reduce';
import { familyOf } from './selectors';
import { emptySession, type ChatState, type Message, type SessionState, type Store } from './store';

export function createKeys() {
  // `started` is false while a reload waits for the load it replaces. Invalidations that land in
  // that window are already covered, since the reload has not read anything yet.
  type Pending = { promise: Promise<void>; invalidated: boolean; started: boolean };
  const state = new Map<string, true | Pending>();
  const start = (key: string, load: () => Promise<void>, wait?: Promise<void>) => {
    const entry: Pending = { promise: Promise.resolve(), invalidated: false, started: !wait };
    state.set(key, entry);
    const run = () => { entry.started = true; return load(); };
    entry.promise = (wait ? wait.catch(() => undefined).then(run) : run())
      .then(() => { if (state.get(key) === entry && !entry.invalidated) state.set(key, true); })
      .finally(() => { if (state.get(key) === entry) state.delete(key); });
    return entry.promise;
  };
  return {
    run(key: string, load: () => Promise<void>): Promise<void> {
      const active = state.get(key);
      if (active === true) return Promise.resolve();
      if (!active) return start(key, load);
      if (!active.invalidated) return active.promise;
      return start(key, load, active.promise);
    },
    has: (key: string) => state.has(key),
    pending(key: string) { const active = state.get(key); return active !== undefined && active !== true; },
    invalidate(key?: string) {
      const one = (active: true | Pending | undefined, current: string) => {
        if (active === true) state.delete(current);
        else if (active?.started) active.invalidated = true;
      };
      if (key) one(state.get(key), key);
      else state.forEach(one);
    },
  };
}

export interface SyncOptions {
  client: OpenCodeClient;
  store: Store<ChatState>;
  directory: string;
  /** Messages per page. */
  pageSize: number;
  /** A read started by an event failed (reads a caller awaits reject to the caller). */
  onError(error: unknown): void;
  /** Called after every batch of events has been applied, with the sessions it touched. */
  onBatch?(sessions: ReadonlySet<string>, events: readonly OpenCodeEvent[]): void;
}

/** Trailing window for event bursts that each ask for the same read. */
export const settleMs = 150;
/** A stale session is not read again more often than this. */
const staleInterval = 1_000;
const terminal = new Set(['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted']);

export interface Sync {
  /** A batch from the event stream, in order. */
  events(events: readonly OpenCodeEvent[]): void;
  /** The stream is gone: everything read so far may be behind. */
  offline(): void;
  /** Root sessions, models and the default model; once per connection. */
  catalog(): Promise<void>;
  /** A session's transcript, kept current from then on and read again on every connection. */
  watch(id: string): Promise<void>;
  /** Forget every watched session but `keep` and its family. */
  unwatch(keep?: string): void;
  loadOlder(id: string): Promise<void>;
  /** The id and every known descendant (subagent sessions), parents first. */
  family(id: string): string[];
  /** Read a transcript again now (the outcome of a request this client made is unknown). */
  reload(id: string): Promise<void>;
  dispose(): void;
}

export function createSync(options: SyncOptions): Sync {
  const { client, store } = options;
  const keys = createKeys();
  // Events of a session whose transcript read is in flight, applied after it commits.
  const buffers = new Map<string, OpenCodeEvent[]>();
  const watched = new Set<string>();
  const settling = new Map<string, ReturnType<typeof setTimeout>>();
  const staleRead = new Map<string, number>();
  let scope = new AbortController();
  let online = false, disposed = false, activeKnown = false;
  // Lifecycle events received while the list of running sessions is being read supersede it.
  let activeUpdates: Map<string, 'idle' | 'running' | undefined> | undefined;

  const usable = (signal: AbortSignal) => !disposed && !signal.aborted;
  const editSession = (id: string, edit: (session: SessionState) => SessionState) => store.update(state => {
    const before = state.sessions[id] ?? emptySession(id);
    const after = edit(before);
    return after === before && state.sessions[id] ? state : { ...state, sessions: { ...state.sessions, [id]: after } };
  });
  /** An event-driven read: its failure is reported, unless the connection it ran on is gone. */
  function refresh(load: () => Promise<unknown>) {
    if (disposed || !online) return;
    const signal = scope.signal;
    void load().catch(error => { if (usable(signal)) options.onError(error); });
  }
  /** Runs `load` once a burst of same-key requests goes quiet. */
  function settle(key: string, load: () => Promise<unknown>, delay = settleMs) {
    clearTimeout(settling.get(key));
    settling.set(key, setTimeout(() => { settling.delete(key); refresh(load); }, delay));
  }
  const remember = (info: SessionInfo) => editSession(info.id, session =>
    ({ ...session, info, parentID: info.parentID, status: session.status === 'unknown' && activeKnown ? 'idle' : session.status }));

  async function active(): Promise<void> {
    const signal = scope.signal, updates = new Map<string, 'idle' | 'running' | undefined>();
    activeUpdates = updates;
    try {
      const running = await client.session.active({ signal });
      if (!usable(signal) || activeUpdates !== updates) return;
      activeUpdates = undefined;
      activeKnown = true;
      store.update(state => {
        const sessions: Record<string, SessionState> = {};
        for (const id of new Set([...Object.keys(state.sessions), ...Object.keys(running)])) {
          const session = state.sessions[id] ?? emptySession(id);
          const status = updates.get(id) ?? (running[id] ? 'running' : 'idle');
          sessions[id] = session.status === status ? session : { ...session, status };
        }
        return { ...state, sessions };
      });
      autoload();
    } finally {
      if (activeUpdates === updates) activeUpdates = undefined;
    }
  }

  const catalog = () => keys.run('catalog', async () => {
    const signal = scope.signal, location = { directory: options.directory };
    const roots = async () => {
      const found: SessionInfo[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await client.session.list({ directory: options.directory, parentID: null, limit: 100, ...(cursor ? { cursor } : { order: 'desc' as const }) }, { signal });
        found.push(...page.data);
        cursor = page.cursor.next ?? undefined;
        if (cursor && seen.has(cursor)) throw new Error('Repeated session cursor');
        if (cursor) seen.add(cursor);
      } while (cursor && found.length < 10_000);
      return found;
    };
    const [sessions, models, fallback] = await Promise.all([
      roots(), client.model.list({ location }, { signal }), client.model.default({ location }, { signal }),
    ]);
    if (!usable(signal)) return;
    const listed = new Set(sessions.map(info => info.id));
    store.batch(() => {
      store.update(state => {
        const next: Record<string, SessionState> = {};
        // A root that is gone from the list was deleted while this client was away.
        for (const [id, session] of Object.entries(state.sessions))
          if (!session.info || session.info.parentID || listed.has(id) || id === state.sessionID || session.outbox.length) next[id] = session;
        return { ...state, sessions: next, models: models.data, defaultModel: modelRef(fallback.data), ready: true };
      });
      for (const info of sessions) remember(info);
    });
  });
  const models = () => keys.run('models', async () => {
    const signal = scope.signal, location = { directory: options.directory };
    const [list, fallback] = await Promise.all([client.model.list({ location }, { signal }), client.model.default({ location }, { signal })]);
    if (usable(signal)) store.update(state => ({ ...state, models: list.data, defaultModel: modelRef(fallback.data) }));
  });
  /** Forms that belong to no session (MCP elicitations). */
  const globalForms = () => keys.run('forms:global', async () => {
    const signal = scope.signal;
    const response = await client.form.list({ location: { directory: options.directory } }, { signal });
    if (usable(signal)) editSession('global', session => ({ ...session, forms: response.data.filter(form => form.sessionID === 'global') }));
  });
  const info = (id: string) => keys.run(`session:${id}`, async () => {
    const signal = scope.signal;
    const found = await client.session.get({ sessionID: id }, { signal });
    if (!usable(signal)) return;
    remember(found);
    autoload();
  });
  const children = (id: string) => keys.run(`children:${id}`, async () => {
    const signal = scope.signal;
    const response = await client.session.list({ parentID: id, order: 'desc', limit: 100 }, { signal });
    if (!usable(signal)) return;
    store.batch(() => { for (const child of response.data) remember(child); });
    autoload();
  });

  const transcript = (id: string) => keys.run(`transcript:${id}`, async () => {
    const signal = scope.signal, buffer: OpenCodeEvent[] = [];
    buffers.set(id, buffer);
    editSession(id, session => session.loading ? session : { ...session, loading: true });
    try {
      // The inbox first: a prompt delivered between the two reads is then in the page, and
      // one admitted between them is in the buffer. The other order can lose a prompt.
      const pending = await client.session.inbox.list({ sessionID: id }, { signal });
      const [page, permissions, forms, found] = await Promise.all([
        client.message.list({ sessionID: id, limit: options.pageSize, order: 'desc' }, { signal }),
        client.permission.list({ sessionID: id }, { signal }),
        client.session.form.list({ sessionID: id }, { signal }),
        client.session.get({ sessionID: id }, { signal }),
      ]);
      if (!usable(signal)) throw signal.reason ?? new Error('Chat is closed');
      editSession(id, session => applySnapshot(
        { ...session, info: found, parentID: found.parentID, status: session.status === 'unknown' && activeKnown ? 'idle' : session.status },
        { messages: page.data.toReversed(), older: page.cursor.next ?? undefined, pending, permissions, forms }, buffer));
    } catch (error) {
      // What was held back is applied to the state the failed read left alone.
      store.update(state => {
        let session = state.sessions[id];
        if (!session) return state;
        session = { ...session, loading: false };
        for (const event of buffer) session = reduceSession(session, event);
        return { ...state, sessions: { ...state.sessions, [id]: session } };
      });
      throw error;
    } finally {
      if (buffers.get(id) === buffer) buffers.delete(id);
    }
  });
  const load = (id: string) => Promise.all([transcript(id), children(id)]).then(() => { autoload(); });

  /** Subagent sessions of a watched conversation that are running are followed without
   * being asked for: what they do, and what they ask, is shown under the parent's tool call. */
  function autoload() {
    if (!online || disposed) return;
    const state = store.get(), sessions = state.sessions;
    for (const root of [...watched]) {
      for (const id of familyOf(state, root)) {
        const session = sessions[id];
        if (!session || id === root) continue;
        if (session.status === 'running' && !session.loaded && !keys.has(`transcript:${id}`)) {
          watched.add(id);
          refresh(() => load(id));
        }
      }
    }
  }

  function connected() {
    scope.abort(new DOMException('The event stream was replaced', 'AbortError'));
    scope = new AbortController();
    online = true;
    activeKnown = false;
    keys.invalidate();
    forget();
    refresh(active);
    refresh(catalog);
    refresh(globalForms);
    for (const id of watched) refresh(() => load(id));
  }
  /** Nothing read before now is known to be current. */
  function forget() {
    store.update(state => {
      const sessions: Record<string, SessionState> = {};
      for (const [id, session] of Object.entries(state.sessions))
        sessions[id] = !session.loaded && !session.loading && !session.loadingOlder && session.status === 'unknown'
          ? session : { ...session, loaded: false, loading: false, loadingOlder: false, status: 'unknown' };
      return { ...state, sessions, ready: false };
    });
  }

  function events(batch: readonly OpenCodeEvent[]) {
    if (disposed) return;
    const touched = new Set<string>();
    store.batch(() => {
      for (const event of batch) {
        if (event.type === 'server.connected') { connected(); continue; }
        const id = eventSession(event);
        if (!id) { location(event); continue; }
        touched.add(id);
        if (activeUpdates) {
          if (event.type === 'session.execution.started') activeUpdates.set(id, 'running');
          else if (terminal.has(event.type)) activeUpdates.set(id, 'idle');
          else if (event.type === 'session.deleted') activeUpdates.set(id, undefined);
        }
        const buffer = buffers.get(id);
        if (buffer) { buffer.push(event); continue; }
        const fresh = !store.get().sessions[id];
        store.update(state => reduce(state, event));
        if (fresh && activeKnown) editSession(id, session => session.status === 'unknown' ? { ...session, status: 'idle' } : session);
        if (event.type === 'session.deleted') { watched.delete(id); continue; }
        // A run that ended changed the session's cost, tokens, title and times.
        if (terminal.has(event.type) && store.get().sessions[id]?.info) settle(`info:${id}`, () => { keys.invalidate(`session:${id}`); return info(id); });
      }
    });
    const sessions = store.get().sessions;
    for (const id of touched) {
      const session = sessions[id];
      if (!session || id === 'global') continue;
      // A session this client has never read: who is it, and whose child?
      if (!session.info && !keys.has(`session:${id}`)) refresh(() => info(id));
      if (session.stale && session.loaded && !buffers.has(id) && !settling.has(`stale:${id}`)) {
        const wait = Math.max(settleMs, staleInterval - (Date.now() - (staleRead.get(id) ?? 0)));
        settle(`stale:${id}`, () => {
          staleRead.set(id, Date.now());
          keys.invalidate(`transcript:${id}`);
          return transcript(id);
        }, wait);
      }
    }
    autoload();
    options.onBatch?.(touched, batch);
  }
  /** Events of the location rather than of a session. */
  function location(event: OpenCodeEvent) {
    switch (event.type) {
      case 'model.updated':
      case 'provider.updated':
      case 'integration.updated':
      case 'credential.updated':
      case 'credential.switched':
        settle('models', () => { keys.invalidate('models'); return models(); });
    }
  }

  return {
    events,
    offline() {
      if (!online) return;
      online = false;
      activeKnown = false;
      activeUpdates = undefined;
      scope.abort(new DOMException('The event stream ended', 'AbortError'));
      keys.invalidate();
      for (const timer of settling.values()) clearTimeout(timer);
      settling.clear();
      forget();
    },
    catalog,
    watch(id) {
      watched.add(id);
      return online ? load(id) : Promise.resolve();
    },
    unwatch(keep) {
      const kept = keep ? new Set(familyOf(store.get(), keep)) : new Set<string>();
      for (const id of [...watched]) if (!kept.has(id)) watched.delete(id);
    },
    async loadOlder(id) {
      const session = store.get().sessions[id];
      if (!session?.loaded || !session.older || session.loadingOlder || !online) return;
      const signal = scope.signal, cursor = session.older;
      editSession(id, current => ({ ...current, loadingOlder: true }));
      try {
        const page = await client.message.list({ sessionID: id, limit: options.pageSize, cursor }, { signal });
        if (!usable(signal)) return;
        const next = page.cursor.next ?? undefined;
        if (next === cursor) throw new Error('Repeated history cursor');
        editSession(id, current => {
          // A read that started over in the meantime owns the transcript and its cursor.
          if (current.older !== cursor) return current;
          const older = page.data.toReversed().filter(message => !current.messages[message.id]);
          const messages: Record<string, Message> = { ...current.messages };
          for (const message of older) messages[message.id] = message;
          return { ...current, order: [...older.map(message => message.id), ...current.order], messages, older: next };
        });
      } finally {
        if (usable(signal)) editSession(id, current => current.loadingOlder ? { ...current, loadingOlder: false } : current);
      }
    },
    family: id => familyOf(store.get(), id),
    reload(id) {
      if (!online || disposed) return Promise.resolve();
      keys.invalidate(`transcript:${id}`);
      return transcript(id);
    },
    dispose() {
      disposed = true;
      online = false;
      scope.abort(new DOMException('Chat is closed', 'AbortError'));
      for (const timer of settling.values()) clearTimeout(timer);
      settling.clear();
      buffers.clear();
    },
  };
}

const modelRef = (model: ModelInfo | null): ModelRef | undefined => model ? { id: model.id, providerID: model.providerID } : undefined;
