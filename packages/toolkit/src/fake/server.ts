import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile, lstat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { connect } from 'node:net';
import { dirname, resolve, sep } from 'node:path';
import type { ServerWebSocket, WebSocketHandler } from 'bun';
import type { Launch } from '../runtime-host';

/**
 * Server half of the development fake host (see ./browser.ts). Guest paths are mapped to
 * real directories, guest programs run as native processes, guest ports are native
 * loopback ports. Development only: whoever can reach these routes can run programs on
 * this machine. Bind the server to loopback.
 */
export interface FakeHostOptions {
  /** Guest directory → real directory (`{ '/workspace': '/tmp/x/workspace', '/app': '/tmp/x/app' }`). */
  mounts: Record<string, string>;
  /** Symlinks to create inside the mounts when missing: guest path → real target
   * (`{ '/workspace/node_modules': '<app>/node_modules' }`): the stand-in for the image. */
  links?: Record<string, string>;
  /** Guest port → native loopback port. A program is told its native port by rewriting
   * an argv token equal to the guest port and through `BAT_FAKE_PORT_<guest port>`. */
  ports: Record<number, number>;
  /** What a guest program uses for the page's server (`http://127.0.0.1:4110`). */
  hostOrigin: string;
}

const base = '/__fake-host/';
const coi = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' };
type Upstream = { upstream?: WebSocket; url: string; protocols: string[]; queue: (string | ArrayBufferLike | Uint8Array)[] };

export function createFakeHost(options: FakeHostOptions) {
  const mounts = Object.entries(options.mounts).map(([guest, real]) => [guest.replace(/\/$/, ''), resolve(real)] as const).sort((a, b) => b[0].length - a[0].length);
  const mapPath = (path: string): string | undefined => {
    for (const [guest, real] of mounts) if (path === guest || path.startsWith(guest + '/')) return real + path.slice(guest.length);
    return undefined;
  };
  const real = (path: string) => {
    const mapped = mapPath(path);
    if (!mapped || path.split('/').includes('..')) throw Object.assign(Error(`ENOENT: no such file or directory, '${path}'`), { code: 'ENOENT' });
    return mapped;
  };
  /** Map a guest path, or a colon-separated list of them; other strings pass through. */
  const mapValue = (value: string) => value.split(':').map(part => mapPath(part) ?? part).join(':');
  const processes = new Map<string, { child: ChildProcess; exit: Promise<{ code: number | null; signal: string | null }> }>();
  // Browsers allow six connections per host, so all process output shares one stream:
  // lines of JSON, `{ id, stream, data }` (base64) and `{ id, exit }`.
  const subscribers = new Set<ReadableStreamDefaultController<string>>();
  const send = (message: unknown) => { for (const subscriber of subscribers) { try { subscriber.enqueue(JSON.stringify(message) + '\n'); } catch { subscribers.delete(subscriber); } } };
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...coi } });
  const nativePort = (guest: string) => {
    const port = options.ports[Number(guest)];
    if (!port) throw Object.assign(Error(`Fake host has no native port for guest port ${guest}`), { code: 'EINVAL' });
    return port;
  };
  const listening = (port: number) => new Promise<boolean>(done => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', () => done(false));
  });
  const killAll = async () => {
    for (const { child } of processes.values()) child.kill('SIGKILL');
    await Promise.all([...processes.values()].map(item => item.exit));
    processes.clear();
  };

  async function boot() {
    // One editor at a time, like one tab per origin: a reload starts clean.
    await killAll();
    for (const [, directory] of mounts) await mkdir(directory, { recursive: true });
    for (const [guest, target] of Object.entries(options.links ?? {})) {
      const path = real(guest);
      if (await lstat(path).then(() => true, () => false)) continue;
      await mkdir(dirname(path), { recursive: true });
      await symlink(resolve(target), path);
    }
    return json({ hostOrigin: options.hostOrigin });
  }

  async function fs(op: string, url: URL, request: Request): Promise<Response> {
    const path = real(url.searchParams.get('path') ?? '');
    switch (op) {
      case 'read': return new Response(await readFile(path), { headers: { 'Cache-Control': 'no-store', ...coi } });
      case 'write': await writeFile(path, new Uint8Array(await request.arrayBuffer())); return json({});
      case 'stat': { const info = await stat(path); return json({ isFile: info.isFile(), isDirectory: info.isDirectory(), size: info.size, mtimeMs: info.mtimeMs }); }
      case 'readdir': return json(await readdir(path));
      case 'mkdir': await mkdir(path, { recursive: true }); return json({});
      case 'remove': await rm(path, { recursive: true, force: true }); return json({});
      case 'rename': await rename(path, real(url.searchParams.get('to') ?? '')); return json({});
      case 'watch': {
        const guest = url.searchParams.get('path')!.replace(/\/$/, '');
        let watcher: ReturnType<typeof watch> | undefined;
        return new Response(new ReadableStream({
          start(controller) {
            watcher = watch(path, { recursive: true }, (_, name) => {
              if (name) controller.enqueue(`data: ${JSON.stringify({ paths: [`${guest}/${String(name).split(sep).join('/')}`] })}\n\n`);
            });
          },
          cancel() { watcher?.close(); },
        }), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', ...coi } });
      }
    }
    return json({ message: 'Unknown fs operation' }, 404);
  }

  function start(id: string, launch: Launch) {
    const ports = Object.entries(options.ports);
    const argv = launch.argv.map(mapValue).map(arg => {
      const port = ports.find(([guest]) => guest === arg);
      // Never listen beyond loopback natively.
      return port ? String(port[1]) : arg === '0.0.0.0' ? '127.0.0.1' : arg;
    });
    const env: Record<string, string> = Object.fromEntries(Object.entries(launch.env ?? {}).map(([key, value]) => [key, mapValue(value)]));
    // The guest PATH names the image's /bin; natively the programs are the machine's.
    env.PATH = [env.PATH, process.env.PATH].filter(Boolean).join(':');
    for (const [guest, native] of ports) env[`BAT_FAKE_PORT_${guest}`] = String(native);
    const child = spawn(argv[0]!, argv.slice(1), { cwd: launch.cwd ? mapValue(launch.cwd) : '/', env, stdio: ['pipe', 'pipe', 'pipe'] });
    const exit = new Promise<{ code: number | null; signal: string | null }>(done => {
      child.once('error', error => { console.error(`[fake-host] ${argv[0]}: ${error.message}`); done({ code: 127, signal: null }); });
      child.once('exit', (code, signal) => done({ code, signal }));
    });
    processes.set(id, { child, exit });
    for (const stream of ['stdout', 'stderr'] as const) child[stream]!.on('data', (chunk: Buffer) => send({ id, stream, data: chunk.toString('base64') }));
    void exit.then(result => send({ id, exit: result }));
    return json({ id });
  }

  async function proc(id: string, action: string, request: Request): Promise<Response> {
    const entry = processes.get(id);
    if (!entry) return json({ message: 'No such process' }, 404);
    const { child } = entry;
    switch (action) {
      case 'stdin': child.stdin?.write(new Uint8Array(await request.arrayBuffer())); return json({});
      case 'close-stdin': child.stdin?.end(); return json({});
      case 'kill': child.kill((await request.json().catch(() => ({}))).signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'); return json({});
    }
    return json({ message: 'Unknown process action' }, 404);
  }

  // A guest program's API speaks guest paths (`/workspace`); the native one knows only
  // real ones. Translate both ways in what the page exchanges with a guest port.
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const toReal = (text: string) => mounts.reduce((value, [guest, real]) => value.replace(new RegExp(`(?<![\\w.~-])${escape(guest)}(?=[/"'&\\\\]|$)`, 'g'), real), text);
  const toGuest = (text: string) => mounts.reduce((value, [guest, real]) => value.replaceAll(real, guest), text);
  async function api(request: Request, port: number, path: string, search: URLSearchParams): Promise<Response> {
    const query = new URLSearchParams([...search].map(([key, value]) => [key, toReal(value)]));
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : toReal(await request.text());
    const translated = new Request(request.url, { method: request.method, headers: request.headers, body, signal: request.signal });
    const response = await forward(translated, port, path + (query.size ? `?${query}` : ''));
    const type = response.headers.get('content-type') ?? '';
    if (!response.body || !/json|event-stream|text/.test(type)) return response;
    const decoder = new TextDecoder();
    let rest = '';
    // Line by line, so a path is never split across chunks.
    const lines = new TransformStream<Uint8Array, string>({
      transform(chunk, controller) {
        const text = rest + decoder.decode(chunk, { stream: true }), cut = text.lastIndexOf('\n') + 1;
        rest = text.slice(cut);
        if (cut) controller.enqueue(toGuest(text.slice(0, cut)));
      },
      flush(controller) { if (rest) controller.enqueue(toGuest(rest)); },
    });
    return new Response(response.body.pipeThrough(lines), { status: response.status, headers: response.headers });
  }

  /** Forward to a native port, streaming both ways, with the isolation headers a frame needs. */
  async function forward(request: Request, port: number, path: string): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.delete('host'); headers.delete('accept-encoding'); headers.delete('content-length');
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: request.method, headers, redirect: 'manual', signal: request.signal,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      });
    } catch (error) { return json({ message: `Nothing answers on guest port (native ${port}): ${(error as Error).message}` }, 502); }
    const outgoing = new Headers(response.headers);
    for (const name of ['content-encoding', 'content-length', 'transfer-encoding', 'connection']) outgoing.delete(name);
    for (const [name, value] of Object.entries(coi)) outgoing.set(name, value);
    return new Response(response.body, { status: response.status, headers: outgoing });
  }

  const websocket: WebSocketHandler<Upstream> = {
    open(socket) {
      const data = socket.data;
      const upstream = data.upstream = new WebSocket(data.url, data.protocols);
      upstream.binaryType = 'arraybuffer';
      upstream.onopen = () => { for (const message of data.queue.splice(0)) upstream.send(message as string); };
      upstream.onmessage = event => { socket.send(event.data as string); };
      upstream.onclose = () => socket.close();
      upstream.onerror = () => socket.close();
    },
    message(socket: ServerWebSocket<Upstream>, message) {
      const { upstream, queue } = socket.data;
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(message as string); else queue.push(message);
    },
    close(socket) { socket.data.upstream?.close(); },
  };

  return {
    websocket,
    matches: (request: Request) => { const path = new URL(request.url).pathname; return path.startsWith(base) || path.startsWith('/preview/'); },
    /** `undefined`: the request was upgraded to a WebSocket. */
    async fetch(request: Request, server: { upgrade(request: Request, options?: any): boolean }): Promise<Response | undefined> {
      const url = new URL(request.url), path = url.pathname;
      try {
        const preview = /^\/preview\/(\d+)\//.exec(path);
        if (preview) {
          const port = nativePort(preview[1]!);
          if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
            const protocols = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map(item => item.trim()).filter(Boolean);
            const data: Upstream = { url: `ws://127.0.0.1:${port}${path}${url.search}`, protocols, queue: [] };
            return server.upgrade(request, { data, headers: protocols[0] ? { 'Sec-WebSocket-Protocol': protocols[0] } : undefined })
              ? undefined : json({ message: 'WebSocket upgrade failed' }, 400);
          }
          return forward(request, port, path + url.search);
        }
        const [area, a, b, ...rest] = path.slice(base.length).split('/');
        if (area === 'boot') return boot();
        if (area === 'events') {
          let own: ReadableStreamDefaultController<string> | undefined;
          return new Response(new ReadableStream<string>({
            start(controller) { subscribers.add(own = controller); controller.enqueue('{}\n'); },
            cancel() { if (own) subscribers.delete(own); },
          }), { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', ...coi } });
        }
        if (area === 'close') { await killAll(); return json({}); }
        if (area === 'fs') return await fs(a!, url, request);
        if (area === 'spawn') { const body = await request.json(); return start(String(body.id), body.launch); }
        if (area === 'proc') return await proc(a!, b!, request);
        if (area === 'port' && b === 'ready') {
          const port = nativePort(a!), deadline = Date.now() + 20_000;
          while (Date.now() < deadline && !request.signal.aborted) {
            if (await listening(port)) return json({ listening: true });
            await new Promise(done => setTimeout(done, 25));
          }
          return json({ listening: false });
        }
        if (area === 'port' && b === 'http') return await api(request, nativePort(a!), '/' + rest.join('/'), url.searchParams);
        return json({ message: 'Unknown fake host route' }, 404);
      } catch (error) {
        const code = (error as { code?: string }).code;
        return json({ message: (error as Error).message, code }, code === 'ENOENT' ? 404 : 500);
      }
    },
    close: killAll,
  };
}
