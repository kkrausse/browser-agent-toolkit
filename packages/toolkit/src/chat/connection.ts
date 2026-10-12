// The event connection: one `GET /api/event` stream kept alive.
//
// Ported from OpenCode 2.0.26, `packages/client/src/solid/connection.ts` (MIT, see
// ../../NOTICES.md), without Solid: status goes to a callback instead of a store, and the
// batch of events goes to one `onEvents` call instead of a Solid `batch`. The loop is the
// official one: a connect timeout, a fixed back-off, an idle watchdog fed by every byte
// (the server writes a keepalive comment every 15 s), a resync when the page returns to the
// foreground after silence or the network comes back, and events flushed in batches.
//
// The server has no replay and no Last-Event-ID: what was missed while disconnected is
// recovered by reading again (see ./sync.ts), which the owner starts on `server.connected`.
import type { OpenCodeClient, OpenCodeEvent } from '@opencode/client';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'stopped';
export interface ConnectionState {
  readonly status: ConnectionStatus;
  /** Consecutive failed attempts; 0 while connected or on the first attempt. */
  readonly attempt: number;
  /** Why the last attempt ended. */
  readonly error?: string;
}
export interface ConnectionRecord { readonly at: number; readonly status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting'; readonly attempt: number; readonly error?: string }

export interface ConnectionOptions {
  /** Every batch, in stream order. The first event of every connection is `server.connected`. */
  onEvents(events: readonly OpenCodeEvent[]): void;
  onState(state: ConnectionState): void;
  /** Events are held this long and delivered together (default 16 ms, one frame; upstream 10). */
  flushInterval?: number;
  /** A connected stream with no bytes for this long is dropped and replaced (default 45 s). */
  idleTimeout?: number;
  /** How long one attempt may take to deliver `server.connected` (default 2 s). */
  connectTimeout?: number;
  /** The same for the first attempt after `start()`, where the server may still be booting. */
  firstConnectTimeout?: number;
  /** Wait between attempts (default 1 s). */
  reconnectDelay?: number;
  /** Stop on `pagehide`, start on `pageshow`, resync on `online` and on a return to the
   * foreground after `foregroundIdle` of silence. Default: on where there is a document. */
  pageLifecycle?: boolean;
  log?(message: string, data?: Record<string, unknown>): void;
}

export const defaultIdleTimeout = 45_000;
// Longer than one server keepalive interval: a stream that is silent this long when the page
// returns to the foreground is probably half-open after the device slept.
export const foregroundIdleThreshold = 20_000;
const historyLimit = 50;

export interface Connection {
  state(): ConnectionState;
  /** Idempotent. Resolves when the loop it started has ended (stop or dispose). */
  start(): Promise<void>;
  /** Drops the stream; nothing is listening until `start()`. */
  stop(): void;
  /** Drop a connected stream so the loop replaces it now, without back-off. */
  resync(reason: string): void;
  history(): ConnectionRecord[];
  /** Stops, removes page listeners and drops undelivered events. Resolves when the loop has ended. */
  dispose(): Promise<void>;
}

export function createConnection(client: OpenCodeClient, options: ConnectionOptions): Connection {
  const abort = new AbortController();
  const history: ConnectionRecord[] = [];
  const idleTimeout = options.idleTimeout ?? defaultIdleTimeout;
  const connectTimeout = options.connectTimeout ?? 2_000;
  const reconnectDelay = options.reconnectDelay ?? 1_000;
  let state: ConnectionState = { status: 'stopped', attempt: 0 };
  let pending: OpenCodeEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let stream: AbortController | undefined;
  let current: AbortController | undefined;
  let run: Promise<void> | undefined;
  let started = false, first = true;
  let generation = 0;
  let lastActivity = 0;
  let forced = false;

  const setState = (next: ConnectionState) => {
    if (next.status === state.status && next.attempt === state.attempt && next.error === state.error) return;
    state = next;
    options.onState(state);
  };
  function record(status: ConnectionRecord['status'], attempt: number, error?: string) {
    history.push({ at: Date.now(), status, attempt, error });
    if (history.length > historyLimit) history.shift();
  }
  function flush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    if (!pending.length) return;
    const events = pending;
    pending = [];
    options.onEvents(events);
  }
  function publish(event: OpenCodeEvent) {
    pending.push(event);
    flushTimer ??= setTimeout(flush, options.flushInterval ?? 16);
  }

  async function connect(signal: AbortSignal, attempt: number, limit: number) {
    let connectedAt: number | undefined;
    const request = new AbortController();
    current = request;
    const cancel = () => request.abort(signal.reason);
    const timeout = setTimeout(() => request.abort(new Error('Timed out connecting to server')), limit);
    signal.addEventListener('abort', cancel, { once: true });
    // Any received bytes, including keepalive comments, push the stall deadline out. A timer whose
    // deadline passed while the page was suspended fires as soon as the page resumes.
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      lastActivity = Date.now();
      if (connectedAt === undefined) return;
      clearTimeout(watchdog);
      watchdog = setTimeout(() => request.abort(new Error('Event stream stalled')), idleTimeout);
    };
    const ended = () => request.signal.reason instanceof Error ? request.signal.reason : new Error('Event stream disconnected');
    try {
      record(attempt === 0 ? 'connecting' : 'reconnecting', attempt);
      options.log?.('event stream connecting', { attempt });
      const iterator = client.event.subscribe({ signal: request.signal, onActivity: touch })[Symbol.asyncIterator]();
      const opening = await iterator.next();
      if (signal.aborted) return { error: undefined, connectedAt };
      if (opening.done) return { error: ended(), connectedAt };
      if (opening.value.type !== 'server.connected') return { error: new Error('Event stream did not start with server.connected'), connectedAt };
      clearTimeout(timeout);
      record('connected', attempt);
      connectedAt = Date.now();
      touch();
      options.log?.('event stream connected');
      // What the previous connection had not delivered yet belongs before this marker.
      flush();
      setState({ status: 'connected', attempt: 0 });
      publish(opening.value);
      flush();
      while (!signal.aborted) {
        const event = await iterator.next();
        if (signal.aborted) return { error: undefined, connectedAt };
        if (event.done) return { error: ended(), connectedAt };
        touch();
        publish(event.value);
      }
      return { error: undefined, connectedAt };
    } catch (error) {
      return { error, connectedAt };
    } finally {
      request.abort();
      if (current === request) current = undefined;
      clearTimeout(timeout);
      clearTimeout(watchdog);
      signal.removeEventListener('abort', cancel);
    }
  }

  async function runStream(active: number) {
    let attempt = 0;
    while (!abort.signal.aborted && started && generation === active) {
      setState({ status: attempt === 0 ? 'connecting' : 'reconnecting', attempt, error: attempt === 0 ? undefined : state.error });
      const controller = new AbortController();
      stream = controller;
      const cancel = () => controller.abort(abort.signal.reason);
      abort.signal.addEventListener('abort', cancel);
      const limit = first ? options.firstConnectTimeout ?? connectTimeout : connectTimeout;
      const result = await connect(controller.signal, attempt, limit);
      abort.signal.removeEventListener('abort', cancel);
      // Events of a stream that ended are delivered before its end is reported.
      flush();
      if (abort.signal.aborted || !started || generation !== active) return;
      if (result.connectedAt !== undefined) first = false;
      if (result.connectedAt !== undefined && Date.now() - result.connectedAt >= reconnectDelay) attempt = 0;
      attempt += 1;
      const message = errorMessage(result.error);
      record('disconnected', attempt, message);
      options.log?.('event stream disconnected', { attempt, error: message });
      setState({ status: 'reconnecting', attempt, error: message });
      // A deliberate resync already knows the old socket is gone; reconnect without backing off.
      if (forced) { forced = false; continue; }
      await wait(reconnectDelay, controller.signal);
    }
  }

  function start(): Promise<void> {
    if (abort.signal.aborted) return Promise.resolve();
    if (started && run) return run;
    started = true;
    forced = false;
    const active = ++generation;
    const previous = run;
    const next: Promise<void> = (async () => {
      if (previous) await previous;
      await runStream(active);
    })().finally(() => { if (run === next) run = undefined; });
    run = next;
    return next;
  }
  function stop() {
    if (!started) return;
    started = false;
    generation += 1;
    stream?.abort();
    // Nothing is listening once stopped, so consumers must treat their data as stale until start() reconnects.
    setState({ status: 'stopped', attempt: 0 });
  }
  function resync(reason: string) {
    if (!started || state.status !== 'connected') return;
    options.log?.('event stream resync', { reason, idle: Date.now() - lastActivity });
    forced = true;
    current?.abort(new Error(reason));
  }

  const removers: (() => void)[] = [];
  if ((options.pageLifecycle ?? typeof document !== 'undefined') && typeof document !== 'undefined' && typeof window !== 'undefined') {
    const listen = (target: EventTarget, type: string, listener: () => void) => {
      target.addEventListener(type, listener);
      removers.push(() => target.removeEventListener(type, listener));
    };
    // The page is being put away (back/forward cache): the stream would die unseen.
    let hidden = false;
    listen(window, 'pagehide', () => { if (started) { hidden = true; stop(); } });
    listen(window, 'pageshow', () => { if (hidden) { hidden = false; void start(); } });
    listen(window, 'online', () => resync('Network connection restored'));
    // Locking a phone or switching apps hides the document without a pagehide; the socket usually
    // dies while the page is suspended, and the browser may never report that on the hung read.
    listen(document, 'visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastActivity < foregroundIdleThreshold) return;
      resync('Page returned to the foreground after the event stream went quiet');
    });
  }

  return {
    state: () => state,
    start,
    stop,
    resync,
    history: () => history.slice(),
    dispose() {
      const ending = run;
      stop();
      abort.abort();
      for (const remove of removers.splice(0)) remove();
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      pending = [];
      return (ending ?? Promise.resolve()).catch(() => {});
    },
  };
}

function errorMessage(error: unknown) {
  if (error === undefined) return undefined;
  if (error instanceof Error) return error.message;
  return String(error);
}

function wait(delay: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const timer = setTimeout(done, delay);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
