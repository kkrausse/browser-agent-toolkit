import type { BootRuntime, Launch, RuntimeEndpoint, RuntimeFs, RuntimeHost, RuntimeProcess } from './runtime-host';
import { decodeSourceFile, parseManifest, toLaunch, workspaceRoot, type EditorManifest, type SourceFile } from './manifest';
import { agentLaunch, defaultAgent, installAgentConfig, openCode, verifyAgentReady } from './opencode';
import { createChatController } from './chat/controller';
import type { ChatController } from './chat/types';
import { exportSessions, importSessions, type SessionBundle } from './sessions';

export type { BootRuntime, RuntimeHost, RuntimeFs, RuntimeEndpoint, RuntimeProcess, Launch } from './runtime-host';
export type { EditorManifest, LaunchDescription } from './manifest';
export type { SessionBundle } from './sessions';
export { captureSource, unpackSource, managedNames, type CaptureSourceOptions, type SourceArchive, type SourceLimits } from './source-archive';
export { workspaceRoot } from './manifest';
export { createChatController, canSend } from './chat/controller';
export type * from './chat/types';

/** In start order. Each is recorded once per open, as milliseconds since `openEditor` was called. */
export const editorSteps = ['manifest', 'boot', 'source', 'preview.spawn', 'preview.listening', 'preview.ready', 'agent.spawn', 'agent.ready', 'chat.ready'] as const;
export type EditorStep = typeof editorSteps[number];

export type ServiceState = 'stopped' | 'starting' | 'listening' | 'ready' | 'failed';
export interface EditorSnapshot {
  status: 'opening' | 'ready' | 'failed' | 'closed';
  /** One line for a status area. */
  message: string;
  error?: string;
  /** Step → ms since open began. Also holds app marks (`editor.mark`), e.g. `preview.visible`. */
  timings: Readonly<Record<string, number>>;
  preview: ServiceState;
  agent: ServiceState;
  /** Recent output of both programs and editor notes, newest last (at most 500 lines). */
  log: readonly string[];
}
export type EditorEvent =
  | { type: 'step'; step: string; ms: number }
  | { type: 'log'; source: 'editor' | 'preview' | 'agent'; line: string }
  | { type: 'state'; snapshot: EditorSnapshot }
  | { type: 'chat'; event: string; data?: Record<string, unknown> };

export interface Service {
  readonly endpoint: Pick<RuntimeEndpoint, 'url' | 'fetch'>;
  /** The current start: resolves when the program answers, rejects when that start failed.
   * Replaced by a restart. */
  readonly ready: Promise<void>;
  stop(): Promise<void>;
}

export interface Editor {
  readonly fs: RuntimeFs;
  readonly preview: Service;
  readonly agent: Service;
  /** Throws when the editor was opened with `chat: { attach: false }`. */
  readonly chat: ChatController;
  /** Resolves when preview, agent and chat are all up; rejects with the first failure. The
   * editor stays usable after a failure: read the snapshot, restart a service, or close. */
  readonly ready: Promise<void>;
  /** The page-server prefixes a preview frame should reach natively (see `EditorPreview`). */
  setHostPaths(prefixes: readonly string[]): void;
  restartPreview(): Promise<void>;
  restartAgent(): Promise<void>;
  flush(): Promise<void>;
  /** Stops both programs, flushes and releases the workspace. Idempotent. */
  close(): Promise<void>;
  sessions: {
    /** Native OpenCode sessions of this workspace, resumable after `import`. */
    export(): Promise<SessionBundle[]>;
    /** Replaces this workspace's sessions. Throws unless the chat is idle. */
    import(bundles: SessionBundle[]): Promise<void>;
  };
  /** Record an app-defined timing mark (first call per name wins). */
  mark(name: string): void;
  subscribe(listener: () => void): () => void;
  snapshot(): EditorSnapshot;
}

/** What a workspace starts from instead of the prepared source (`OpenEditorOptions.initialWorkspace`). */
export interface InitialWorkspace {
  /** Project files by path below the workspace (`/src/home.tsx`), e.g. from `unpackSource`.
   * They are the whole source: prepared files that are not among them are not installed. */
  files: Record<string, SourceFile | Uint8Array>;
  /** Native sessions (`editor.sessions.export()`) imported before the chat attaches. */
  sessions?: SessionBundle[];
  /** The saved id of the session the chat opens on. Default: the chat's usual choice. */
  selectedSession?: string;
}

export interface OpenEditorOptions {
  /** Where the server handler is mounted. Default `/editor/`. */
  base?: string;
  /** Called only when this browser holds no workspace yet (a first open, or the first open
   * after `resetWorkspace`), before any source is written: resolve with the source and
   * sessions to start from (a saved workspace), or with nothing for the prepared source.
   * `prepared` is the prepared source, for files the app wants to take from it. A rejection
   * fails the open and leaves the workspace empty, so the next open asks again. */
  initialWorkspace?(context: { prepared: Readonly<Record<string, SourceFile>>; signal?: AbortSignal }): Promise<InitialWorkspace | undefined | void> | InitialWorkspace | undefined | void;
  /** `startNewSession`: open on a new chat session instead of the most recent one.
   * `attach: false`: no chat controller at all (no session is created, no event stream is
   * held): the app brings its own OpenCode client and reaches the server through
   * `editor.agent.endpoint.fetch`, which adds the server's credential. */
  chat?: { startNewSession?: boolean; attach?: boolean };
  /** Every step, log line and state change, from the first moment of the open. */
  onEvent?(event: EditorEvent): void;
  /** Aborting closes the editor. */
  signal?: AbortSignal;
  /** Replaces the runtime the manifest names. Development only (see `./fake`). */
  boot?: BootRuntime;
}

export const openedElsewhereMessage = 'This workspace is already open in another tab or window. Close the editor there, then retry.';
const sourceMarker = `${workspaceRoot}/.server/source-installed`;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * When each program starts: both at once. Each is its own process worker over the shared
 * kernel, so neither waits for the other (measured in docs/experiments/2026-10-09-startup.md;
 * the old runtime's one kernel thread was the reason to stagger them). Both are joined, and
 * the preview's failure is reported first.
 */
export async function startupOrder(preview: { ready: Promise<void> }, startAgent: () => Promise<void>): Promise<void> {
  const agent = startAgent();
  void agent.catch(() => {});
  await preview.ready;
  await agent;
}

/** Write the prepared project files below `/workspace`. Existing files are kept: edits made
 * in this browser win over newly prepared source. A workspace that was installed once owns
 * its whole tree, so files the agent removed are not resurrected. */
export async function installSource(
  fs: RuntimeFs, source: EditorManifest['project'],
  /** Asked once the workspace is known to be new: what to install instead of `source`. */
  initial?: () => Promise<InitialWorkspace | undefined | void>,
): Promise<{ installed: number; preserved: boolean; initial?: InitialWorkspace }> {
  if (await fs.stat(sourceMarker).then(() => true, () => false)) return { installed: 0, preserved: true };
  const supplied = await initial?.() || undefined;
  let installed = 0;
  const made = new Set<string>();
  for (const [path, file] of Object.entries(supplied?.files ?? source).sort(([a], [b]) => a < b ? -1 : 1)) {
    if (!validPath(path)) throw Error(`Invalid source path: ${path}`);
    const target = workspaceRoot + path;
    // Prepared source never replaces a file that is there; a supplied workspace is the
    // whole truth, also over what an interrupted earlier attempt left behind.
    if (!supplied && await fs.stat(target).then(() => true, () => false)) continue;
    const parent = target.slice(0, target.lastIndexOf('/'));
    if (!made.has(parent)) { await fs.mkdir(parent); made.add(parent); }
    await fs.writeFile(target, file instanceof Uint8Array ? file : decodeSourceFile(file));
    installed++;
  }
  await fs.mkdir(`${workspaceRoot}/.server`);
  // With sessions still to import the workspace is not complete: the marker is written
  // after the import (see `openEditor`), so an interrupted start asks for it again.
  if (!supplied?.sessions?.length) await fs.writeFile(sourceMarker, new Date().toISOString());
  return { installed, preserved: false, initial: supplied };
}

/** Prepared files the app owns (`manifest.refresh`, from `prepare({ refresh })`): written
 * again at every open when they differ, unlike source, which is the visitor's once installed. */
export async function refreshOwnedFiles(fs: RuntimeFs, manifest: EditorManifest): Promise<number> {
  let written = 0;
  for (const path of manifest.refresh ?? []) {
    const file = manifest.project[path];
    if (file === undefined || !validPath(path)) continue;
    const want = decodeSourceFile(file), target = workspaceRoot + path;
    const have = await fs.readFile(target).catch(() => undefined);
    if (have && have.length === want.length && have.every((byte, index) => byte === want[index])) continue;
    await fs.mkdir(target.slice(0, target.lastIndexOf('/')));
    await fs.writeFile(target, want);
    written++;
  }
  return written;
}

const derivedMarker = `${workspaceRoot}/.server/derived-installed`;
const validPath = (path: string) => path.startsWith('/') && !path.split('/').slice(1).some(part => !part || part === '.' || part === '..');

/** Install the prepared derived files (see `EditorManifest.derived`). Unlike source, these
 * are never the user's: whenever the prepared bundle or the dependency image is not the
 * one this workspace last installed from, the directories it owns are removed and the
 * bundle is written again, so a workspace kept in the browser never runs on a stale
 * optimizer cache. Otherwise nothing is fetched. */
export async function installDerived(fs: RuntimeFs, manifest: EditorManifest, manifestUrl: string, signal?: AbortSignal): Promise<{ installed: number }> {
  const derived = manifest.derived;
  if (!derived) return { installed: 0 };
  const identity = [derived.file, manifest.image?.file ?? '', ...(manifest.layers ?? []).map(layer => layer.file)].join(' ');
  const have = await fs.readFile(derivedMarker).then(bytes => new TextDecoder().decode(bytes), () => '');
  if (have === identity) return { installed: 0 };
  const response = await fetch(new URL(derived.file, manifestUrl), { signal });
  if (!response.ok) throw Error(`Prepared derived files unavailable: HTTP ${response.status}`);
  const files = await response.json() as Record<string, SourceFile>;
  for (const path of derived.owns) {
    if (!validPath('/' + path)) throw Error(`Invalid derived directory: ${path}`);
    await fs.remove(`${workspaceRoot}/${path}`);
  }
  const made = new Set<string>();
  let installed = 0;
  for (const [path, file] of Object.entries(files)) {
    if (!validPath(path)) throw Error(`Invalid derived path: ${path}`);
    const target = workspaceRoot + path, parent = target.slice(0, target.lastIndexOf('/'));
    if (!made.has(parent)) { await fs.mkdir(parent); made.add(parent); }
    await fs.writeFile(target, decodeSourceFile(file));
    installed++;
  }
  await fs.mkdir(`${workspaceRoot}/.server`);
  await fs.writeFile(derivedMarker, identity);
  return { installed };
}

async function loadRuntime(manifest: EditorManifest, manifestUrl: string): Promise<BootRuntime> {
  if (!manifest.image) throw Error('This prepared directory has no runtime image (it was prepared for the development fake host). Pass `boot`.');
  const entry = new URL(manifest.runtime?.entry ?? 'runtime/host.js', manifestUrl).href;
  const module = await import(/* @vite-ignore */ entry);
  if (typeof module.bootRuntime !== 'function') throw Error(`Runtime module ${entry} does not export bootRuntime`);
  return module.bootRuntime;
}

/**
 * Optional: call when the control that opens the editor is shown (not when it is used), so
 * the open itself starts with the runtime module loaded and the kernel compiled. It fetches
 * the manifest and the runtime's code; it does not take the workspace, write anything or
 * start a program, so it is safe on a page whose visitor never opens the editor. Failures
 * are left for `openEditor` to report.
 */
export function preloadEditor(options: { base?: string } = {}): void {
  const manifestUrl = new URL((options.base ?? '/editor/') + 'manifest.json', location.href).href;
  void (async () => {
    const response = await fetch(manifestUrl, { cache: 'no-store' });
    if (!response.ok) return;
    const manifest = parseManifest(await response.json());
    if (!manifest.image) return;
    const module = await import(/* @vite-ignore */ new URL(manifest.runtime?.entry ?? 'runtime/host.js', manifestUrl).href);
    module.preloadRuntime?.();
  })().catch(() => {});
}

/**
 * Forget this browser's copy of the workspace: source edits, agent sessions and caches. The
 * next `openEditor` starts from the prepared source again (the dependency image is kept).
 * Rejects with `openedElsewhereMessage` while the editor is open in any tab.
 */
export async function resetWorkspace(options: { base?: string } = {}): Promise<void> {
  const manifestUrl = new URL((options.base ?? '/editor/') + 'manifest.json', location.href).href;
  const response = await fetch(manifestUrl, { cache: 'no-store' });
  if (!response.ok) throw Error(`Editor manifest unavailable: HTTP ${response.status}`);
  const manifest = parseManifest(await response.json());
  const module = await import(/* @vite-ignore */ new URL(manifest.runtime?.entry ?? 'runtime/host.js', manifestUrl).href);
  if (typeof module.resetWorkspace !== 'function') throw Error('This runtime cannot reset a workspace');
  try { await module.resetWorkspace({ manifestUrl }); }
  catch (error) {
    if ((error as { code?: string } | null)?.code === 'STORAGE_BUSY') throw Error(openedElsewhereMessage, { cause: error });
    throw error;
  }
}

/** Forward a process's output as log lines, until it ends. */
async function pump(stream: ReadableStream<Uint8Array>, line: (text: string) => void) {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let rest = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      rest += decoder.decode(value, { stream: !done });
      const lines = rest.split('\n');
      rest = lines.pop()!;
      for (const text of lines) if (text.trim()) line(text.slice(0, 2000));
      if (done) break;
    }
    if (rest.trim()) line(rest.slice(0, 2000));
  } catch { /* the runtime closed */ }
}

/**
 * Open the browser editor: load the prepared manifest, boot the runtime, install the
 * project source, write the agent's configuration, start the preview and the agent, and
 * attach the chat. Resolves as soon as the workspace is booted and both programs are
 * starting; `editor.ready` is the rest. Rejects when the workspace cannot be opened.
 */
export async function openEditor(options: OpenEditorOptions = {}): Promise<Editor> {
  const base = options.base ?? '/editor/';
  if (!base.startsWith('/') || !base.endsWith('/')) throw Error('Editor base must start and end with "/"');
  const started = performance.now();
  // User-timing marks (`bat:<step>`) for measuring scripts; a mark costs microseconds.
  const timed = (name: string) => { try { performance.mark(`bat:${name}`); } catch { /* no user timing */ } };
  timed('open');
  const listeners = new Set<() => void>();
  let state: EditorSnapshot = { status: 'opening', message: 'Loading editor…', timings: {}, preview: 'stopped', agent: 'stopped', log: [] };
  const emit = (event: EditorEvent) => { try { options.onEvent?.(event); } catch { /* observer failure */ } };
  const publish = (patch: Partial<EditorSnapshot>) => {
    if (state.status === 'closed') return;
    state = { ...state, ...patch };
    emit({ type: 'state', snapshot: state });
    for (const listener of listeners) listener();
  };
  const mark = (step: string) => {
    if (step in state.timings) return;
    const ms = Math.round(performance.now() - started);
    timed(step);
    emit({ type: 'step', step, ms });
    publish({ timings: { ...state.timings, [step]: ms } });
  };
  const log = (source: 'editor' | 'preview' | 'agent', line: string) => {
    emit({ type: 'log', source, line });
    publish({ log: [...state.log, `[${source}] ${line}`].slice(-500) });
  };
  const lifetime = new AbortController();
  let runtime: RuntimeHost | undefined;
  let closing: Promise<void> | undefined;

  let manifest: EditorManifest;
  let initial: InitialWorkspace | undefined;
  try {
    const manifestUrl = new URL(base + 'manifest.json', location.href).href;
    const response = await fetch(manifestUrl, { signal: options.signal, cache: 'no-store' });
    if (!response.ok) throw Error(`Editor manifest unavailable: HTTP ${response.status}`);
    manifest = parseManifest(await response.json());
    mark('manifest');
    publish({ message: 'Opening local workspace…' });
    const boot = options.boot ?? await loadRuntime(manifest, manifestUrl);
    try { runtime = await boot({ manifestUrl, manifest, signal: options.signal }); }
    catch (error) {
      if ((error as { code?: string } | null)?.code !== 'STORAGE_BUSY') throw error;
      log('editor', errorText(error));
      throw Error(openedElsewhereMessage, { cause: error });
    }
    mark('boot');
    publish({ message: 'Installing project source…' });
    const source = await installSource(runtime.fs, manifest.project,
      options.initialWorkspace && (async () => options.initialWorkspace!({ prepared: manifest.project, signal: options.signal })));
    initial = source.initial;
    timed('source.project');
    log('editor', source.preserved ? 'Kept the workspace already in this browser' : `Installed ${source.installed} source files${initial ? ' of the supplied workspace' : ''}`);
    const refreshed = await refreshOwnedFiles(runtime.fs, manifest);
    if (refreshed) log('editor', `Refreshed ${refreshed} app-owned files`);
    const derived = await installDerived(runtime.fs, manifest, manifestUrl, options.signal);
    timed('source.derived');
    if (derived.installed) log('editor', `Installed ${derived.installed} prepared cache files`);
    await installAgentConfig(runtime.fs, {
      modelBaseURL: `${runtime.hostOrigin}${base}model/opencode/`,
      models: manifest.modelCatalog, defaultModel: manifest.defaultModel,
    });
    mark('source');
  } catch (error) {
    publish({ status: 'failed', message: 'The editor could not open.', error: errorText(error) });
    await runtime?.close().catch(() => {});
    throw error;
  }
  const host = runtime;

  /** One program with a port: spawn, wait for the listener, then its own readiness check. */
  function service(name: 'preview' | 'agent', spec: {
    port: number;
    launch(): Launch;
    check(endpoint: RuntimeEndpoint, signal: AbortSignal): Promise<void>;
    shutdown(process: RuntimeProcess): void;
    listenMs: number;
  }) {
    let process: RuntimeProcess | undefined;
    let run = new AbortController();
    let current = { stopped: false };
    let listening: Promise<void> = Promise.reject(Error(`${name} was not started`));
    let ready: Promise<void> = listening;
    void listening.catch(() => {});
    const endpoint = host.endpoint(spec.port);
    const start = () => {
      run = new AbortController();
      const attempt = (current = { stopped: false });
      const signal = AbortSignal.any([run.signal, lifetime.signal]);
      const launch = spec.launch();
      publish({ [name]: 'starting' });
      const spawned = host.spawn(launch).then(child => {
        process = child;
        mark(`${name}.spawn`);
        void pump(child.stdout, line => log(name, line));
        void pump(child.stderr, line => log(name, line));
        void child.exited.then(exit => {
          if (process !== child) return;
          process = undefined;
          log('editor', `${name} exited (code ${exit.code}, signal ${exit.signal ?? 'none'})`);
          // Unblocks a readiness wait on a program that died first.
          run.abort(Error(`${name} exited with code ${exit.code} before it was ready`));
          publish({ [name]: 'failed' });
        });
        return child;
      });
      listening = spawned.then(async () => {
        const timeout = AbortSignal.timeout(spec.listenMs);
        await endpoint.ready(AbortSignal.any([signal, timeout])).catch(error => {
          throw timeout.aborted ? Error(`${name} did not listen on port ${spec.port} within ${spec.listenMs / 1000}s`) : signal.reason ?? error;
        });
        mark(`${name}.listening`);
        publish({ [name]: 'listening' });
      });
      ready = listening.then(async () => {
        await spec.check(endpoint, signal);
        signal.throwIfAborted();
        mark(`${name}.ready`);
        publish({ [name]: 'ready' });
      });
      void ready.catch(error => {
        if (attempt.stopped || lifetime.signal.aborted) return;
        log('editor', `${name} failed: ${errorText(error)}`);
        publish({ [name]: 'failed' });
      });
      return { listening, ready };
    };
    const stop = async () => {
      const child = process;
      process = undefined;
      current.stopped = true;
      run.abort(Error(`${name} was stopped`));
      publish({ [name]: 'stopped' });
      if (!child) return;
      spec.shutdown(child);
      const gone = await Promise.race([child.exited.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 5000))]);
      if (!gone) { child.kill('SIGKILL'); await child.exited; }
    };
    return { start, stop, endpoint, get ready() { return ready; } };
  }

  const preview = service('preview', {
    port: manifest.launch.preview.port,
    launch: () => toLaunch(manifest.launch.preview, { BROWSER_AGENT_PORT: String(manifest.launch.preview.port) }),
    listenMs: 60_000,
    shutdown: process => process.kill('SIGTERM'),
    // The guest server is configured with the prefix as its base (see ./vite).
    async check(endpoint, signal) {
      const response = await endpoint.fetch(new URL(endpoint.url).pathname, { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
      await response.arrayBuffer();
      if (!response.ok) throw Error(`Preview HTTP ${response.status}`);
    },
  });

  let authorization = '';
  const agentDescription = manifest.launch.agent ?? defaultAgent;
  const agent = service('agent', {
    port: agentDescription.port,
    launch() {
      // A fresh credential per start; it never leaves this page and the guest.
      const password = crypto.randomUUID() + crypto.randomUUID();
      authorization = 'Basic ' + btoa('opencode:' + password);
      return agentLaunch(password, agentDescription);
    },
    listenMs: 60_000,
    // OpenCode shuts down cleanly on end of input.
    shutdown: process => process.closeStdin(),
    check: (endpoint, signal) => verifyAgentReady(endpoint, authorization, signal),
  });
  // What the agent's API clients wait for: the current start's verification. Before the
  // first start it is pending, so the chat can exist from the beginning.
  let adoptFirst!: (start: Promise<void>) => void;
  let agentUp = new Promise<void>(resolve => { adoptFirst = resolve; });
  void agentUp.catch(() => {});
  const authorized = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('authorization', authorization);
    return agent.endpoint.fetch(path, { ...init, headers });
  };
  // A supplied workspace's sessions go in once, on the first verified start, before any API
  // client (the chat) sees the agent; then the workspace is complete and gets its marker.
  let pendingSessions = initial?.sessions?.length ? initial.sessions : undefined;
  let selectedSession: string | undefined;
  const startAgent = () => {
    const start = agent.start();
    const ready = !pendingSessions ? start.ready : start.ready.then(async () => {
      const bundles = pendingSessions;
      if (!bundles) return;
      const ids = await importSessions({ fetch: authorized }, openCode.directory, bundles);
      pendingSessions = undefined;
      if (initial?.selectedSession) selectedSession = ids.get(initial.selectedSession);
      await host.fs.writeFile(sourceMarker, new Date().toISOString());
      log('editor', `Imported ${bundles.length} sessions of the supplied workspace`);
    });
    void ready.catch(() => {});
    agentUp = ready;
    adoptFirst(ready);
    return { ...start, ready };
  };
  /** The agent as its API clients reach it: authorized, and not before it is verified. */
  const agentFetch = async (path: string, init: RequestInit = {}) => {
    await agentUp;
    return authorized(path, init);
  };
  const chat = options.chat?.attach === false ? undefined : createChatController({
    endpoint: { fetch: agentFetch }, directory: openCode.directory, autoCreateSession: true,
    startNewSession: options.chat?.startNewSession && !initial?.selectedSession,
    // Counted from now, and the agent has not been started yet.
    handshakeTimeoutMs: 120_000,
    onDiagnostic: (event, data) => emit({ type: 'chat', event, data }),
  });
  let agentStarted = false;
  const startAgentAndChat = async () => {
    agentStarted = true;
    await startAgent().ready;
    if (!chat) return;
    await chat.ready;
    if (selectedSession && chat.getSnapshot().sessionID !== selectedSession) await chat.selectSession(selectedSession);
    mark('chat.ready');
  };
  const order = preview.start();
  const ready = startupOrder(order, startAgentAndChat);
  void ready.then(
    () => publish({ status: 'ready', message: chat ? 'Ready. Ask the agent to change the app; changes stay local to this browser.' : 'Ready.', error: undefined }),
    error => { if (!lifetime.signal.aborted) publish({ status: 'failed', message: 'The editor did not start completely.', error: errorText(error) }); },
  );
  // Up or failed: nothing waits for the network any more, the image's remainder may use it.
  void ready.catch(() => {}).then(() => host.started?.());
  publish({ message: 'Starting preview and agent…' });

  const restart = async (name: 'preview' | 'agent') => {
    await (name === 'preview' ? preview : agent).stop();
    publish({ status: 'opening', message: `Restarting ${name}…`, error: undefined });
    try {
      if (name === 'preview') {
        await preview.start().ready;
        if (!agentStarted) await startAgentAndChat();
      } else {
        agentStarted = true;
        await startAgent().ready;
        await chat?.reconnect();
      }
      publish({ status: 'ready', message: 'Ready.', error: undefined });
    } catch (error) {
      publish({ status: 'failed', message: `${name} did not restart.`, error: errorText(error) });
      throw error;
    }
  };

  const editor: Editor = {
    fs: host.fs,
    preview: { endpoint: preview.endpoint, get ready() { return preview.ready; }, stop: preview.stop },
    agent: { endpoint: { url: agent.endpoint.url, fetch: agentFetch }, get ready() { return agentUp; }, stop: agent.stop },
    get chat(): ChatController {
      if (!chat) throw Error('This editor was opened without a chat (`chat: { attach: false }`)');
      return chat;
    },
    ready,
    setHostPaths: prefixes => host.setHostPaths(manifest.launch.preview.port, prefixes),
    restartPreview: () => restart('preview'),
    restartAgent: () => restart('agent'),
    flush: () => host.flush(),
    close() {
      return closing ??= (async () => {
        lifetime.abort(Error('The editor was closed'));
        const errors: unknown[] = [];
        await chat?.dispose().catch(error => errors.push(error));
        await Promise.all([preview.stop(), agent.stop()]).catch(error => errors.push(error));
        await host.close().catch(error => errors.push(error));
        state = { ...state, status: 'closed', message: 'Closed.', preview: 'stopped', agent: 'stopped' };
        emit({ type: 'state', snapshot: state });
        for (const listener of listeners) listener();
        listeners.clear();
        if (errors.length) throw errors[0];
      })();
    },
    sessions: {
      export: () => exportSessions({ fetch: agentFetch }, openCode.directory),
      async import(bundles) {
        const hold = chat?.hold('Importing sessions');
        try { await importSessions({ fetch: agentFetch }, openCode.directory, bundles); }
        finally { hold?.release(); }
        await chat?.reconnect();
      },
    },
    mark,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => state,
  };
  if (options.signal?.aborted) void editor.close();
  else options.signal?.addEventListener('abort', () => void editor.close().catch(() => {}), { once: true });
  void ready.catch(() => {});
  return editor;
}
