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
      const { id } = await post('spawn', launch);
      const stream = (name: string) => new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            const reader = (await call(`proc/${id}/${name}`)).body!.getReader();
            for (;;) { const { done, value } = await reader.read(); if (done) break; controller.enqueue(value); }
          } catch { /* closed */ }
          controller.close();
        },
      });
      const process: RuntimeProcess = {
        stdout: stream('stdout'), stderr: stream('stderr'),
        exited: call(`proc/${id}/exit`).then(response => response.json(), () => ({ code: null, signal: 'SIGKILL' })),
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
    close: () => closed ??= post('close').then(() => {}),
  };
  if (signal?.aborted) { await host.close(); throw signal.reason; }
  return host;
};
