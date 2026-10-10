import type { BootRuntime, FileStat, RuntimeEndpoint, RuntimeHost, RuntimeProcess } from '../runtime-host';

/**
 * Development stand-in for the browser runtime: the same `RuntimeHost`, backed by native
 * processes and a real directory behind the dev server (`./server` in this folder).
 * Nothing runs in the tab. It exists so the rest of the toolkit can be exercised
 * without the runtime; it is not a sandbox and must never be served to anyone else.
 */
export const fakeHostBase = '/__fake-host/';

const fail = async (response: Response) => {
  const detail = await response.json().catch(() => ({}));
  throw Object.assign(Error(detail.message ?? `Fake host HTTP ${response.status}`), detail.code ? { code: detail.code } : {});
};

export const bootFakeRuntime: BootRuntime = async ({ signal }) => {
  const call = async (path: string, init?: RequestInit) => {
    const response = await fetch(fakeHostBase + path, { ...init, cache: 'no-store' });
    if (!response.ok) await fail(response);
    return response;
  };
  const post = async (path: string, body?: unknown) => (await call(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  })).json();
  const at = (op: string, path: string) => `fs/${op}?path=${encodeURIComponent(path)}`;
  const { hostOrigin } = await (await call('boot', { method: 'POST', signal })).json();
  let closed: Promise<void> | undefined;
  // One stream carries every process's output and exit (see the server half).
  type Sink = { stdout: ReadableStreamDefaultController<Uint8Array>; stderr: ReadableStreamDefaultController<Uint8Array>; exit(result: { code: number | null; signal: string | null }): void };
  const sinks = new Map<string, Sink>();
  const finish = (id: string, result: { code: number | null; signal: string | null }) => {
    const sink = sinks.get(id);
    if (!sink) return;
    sinks.delete(id);
    for (const controller of [sink.stdout, sink.stderr]) { try { controller.close(); } catch { /* cancelled */ } }
    sink.exit(result);
  };
  const events = new AbortController();
  const eventStream = (await call('events', { signal: events.signal })).body!.pipeThrough(new TextDecoderStream()).getReader();
  void (async () => {
    let rest = '';
    try {
      for (;;) {
        const { done, value } = await eventStream.read();
        if (done) break;
        const lines = (rest + value).split('\n');
        rest = lines.pop()!;
        for (const line of lines) {
          const message = JSON.parse(line);
          if (message.exit) finish(message.id, message.exit);
          else if (message.data) { try { sinks.get(message.id)?.[message.stream as 'stdout' | 'stderr'].enqueue(Uint8Array.from(atob(message.data), char => char.charCodeAt(0))); } catch { /* cancelled */ } }
        }
      }
    } catch { /* closed */ }
    for (const id of [...sinks.keys()]) finish(id, { code: null, signal: 'SIGKILL' });
  })();

  const host: RuntimeHost = {
    hostOrigin,
    fs: {
      readFile: async path => new Uint8Array(await (await call(at('read', path))).arrayBuffer()),
      writeFile: async (path, data) => { await call(at('write', path), { method: 'POST', body: data as BodyInit }); },
      stat: async path => await (await call(at('stat', path))).json() as FileStat,
      readdir: async path => (await call(at('readdir', path))).json(),
      mkdir: async path => { await call(at('mkdir', path), { method: 'POST' }); },
      remove: async path => { await call(at('remove', path), { method: 'POST' }); },
      rename: async (from, to) => { await call(`${at('rename', from)}&to=${encodeURIComponent(to)}`, { method: 'POST' }); },
      watch(path, listener) {
        const source = new EventSource(fakeHostBase + at('watch', path));
        source.onmessage = message => listener(JSON.parse(message.data));
        return () => source.close();
      },
    },
    async spawn(launch) {
      // Registered before the request returns: the server may already be sending output.
      const id = crypto.randomUUID();
      let stdoutSink!: ReadableStreamDefaultController<Uint8Array>, stderrSink!: ReadableStreamDefaultController<Uint8Array>;
      const stdout = new ReadableStream<Uint8Array>({ start(controller) { stdoutSink = controller; } });
      const stderr = new ReadableStream<Uint8Array>({ start(controller) { stderrSink = controller; } });
      const exited = new Promise<{ code: number | null; signal: string | null }>(exit => sinks.set(id, { stdout: stdoutSink, stderr: stderrSink, exit }));
      await post('spawn', { id, launch });
      const process: RuntimeProcess = {
        stdout, stderr, exited,
        write: data => void call(`proc/${id}/stdin`, { method: 'POST', body: data as BodyInit }).catch(() => {}),
        closeStdin: () => void post(`proc/${id}/close-stdin`).catch(() => {}),
        kill: (signal = 'SIGTERM') => void post(`proc/${id}/kill`, { signal }).catch(() => {}),
      };
      return process;
    },
    endpoint(port): RuntimeEndpoint {
      return {
        url: `${location.origin}/preview/${port}/`,
        fetch: (path, init) => fetch(`${fakeHostBase}port/${port}/http${path.startsWith('/') ? path : '/' + path}`, { ...init, redirect: 'manual', cache: 'no-store' }),
        async ready(signal) {
          for (;;) {
            signal?.throwIfAborted();
            const response = await fetch(`${fakeHostBase}port/${port}/ready`, { signal, cache: 'no-store' });
            if ((await response.json()).listening) return;
          }
        },
      };
    },
    // The preview shares the page's origin, so `/api` already reaches the real server.
    setHostPaths() {},
    flush: async () => {},
    close: () => closed ??= post('close').then(() => events.abort()),
  };
  if (signal?.aborted) { await host.close(); throw signal.reason; }
  return host;
};
