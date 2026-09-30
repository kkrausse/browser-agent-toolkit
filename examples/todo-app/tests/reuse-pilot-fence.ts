// Experiment-only: valid solely for the independently reviewed packaged 2.0.3
// finite handlers, exclusive ownership, and no execution/model/tool requests.
import {validatePilotResponse} from './reuse-pilot-contract';
export interface RequestRecord {
  id: number; method: string; url: string;
  state: 'pending' | 'normal' | 'failed' | 'stream';
  started: number; finished?: number; status?: number; error?: string;
}
export function pilotRequestURL(endpointURL: string, guestPath: string) {
  const base = new URL(endpointURL);
  const url = new URL(guestPath.replace(/^\//, ''), base);
  for (const [key, value] of base.searchParams) if (!url.searchParams.has(key)) url.searchParams.append(key, value);
  return url.href;
}
export function createPilotFence(fetch: (input: string, init?: RequestInit) => Promise<Response>, administrative = false, endpointURL?: string, contracts = false) {
  const records: RequestRecord[] = [];
  const pending = new Set<Promise<unknown>>();
  let frozen = false;
  let failed: unknown;
  const endpointFetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (frozen) throw Error('Pilot admission frozen');
    if (failed) throw Error('Pilot already failed', { cause: failed });
    const url = input instanceof Request ? input.url : String(input);
    const request = new Request(url, init);
    const parsed = new URL(url);
    const base = endpointURL ? new URL(endpointURL) : undefined;
    if (base && (parsed.origin !== base.origin || !parsed.pathname.startsWith(base.pathname))) throw Error('Pilot caller route changed');
    const directory = parsed.searchParams.get('location[directory]') ?? parsed.searchParams.get('directory') ?? request.headers.get('x-opencode-directory');
    if (directory && directory !== '/workspace') throw Error('Pilot location changed');
    if (parsed.searchParams.has('location[workspace]') || request.headers.has('x-opencode-workspace')) throw Error('Pilot workspace identity changed');
    const pathname = base ? '/' + parsed.pathname.slice(base.pathname.length) : parsed.pathname;
    const stream = pathname === '/api/event' && request.method === 'GET';
    const permitted = request.method === 'GET' && (/^\/api\/(health|plugin|config|model|project|session|message|permission|form)(\/|$)/.test(pathname))
      || request.method === 'POST' && ['/api/plugin/await-activation', '/api/session'].includes(pathname);
    const eviction = administrative && request.method === 'DELETE' && pathname === '/api/debug/location';
    if (!stream && !permitted && !eviction) throw Error('Pilot route forbidden: ' + request.method + ' ' + pathname);
    const record: RequestRecord = { id: records.length + 1, method: request.method, url, state: stream ? 'stream' : 'pending', started: performance.now() };
    records.push(record);
    const task = (async () => {
      try {
        request.signal.throwIfAborted();
        const response = await fetch(url, init);
        record.status = response.status;
        if (stream) {
          if (!response.ok) throw Error('SSE HTTP ' + response.status);
          return response; // Global stream has no location lease; controller joins cancellation.
        }
        const bytes = await response.arrayBuffer();
        request.signal.throwIfAborted();
        if (!response.ok) throw Error('Finite HTTP ' + response.status);
        if (contracts) validatePilotResponse(pathname, request.method, response.status, new TextDecoder().decode(bytes));
        record.state = 'normal'; record.finished = performance.now();
        return new Response(response.status === 204 ? null : bytes, {status: response.status, headers: response.headers});
      } catch (error) {
        failed = error; record.state = 'failed'; record.error = String(error); record.finished = performance.now();
        throw error;
      }
    })();
    if (!stream) pending.add(task);
    try { return await task; } finally { pending.delete(task); }
  };
  return {
    fetch: endpointFetch, records,
    freeze() { frozen = true; },
    async drain(deadlineMs: number) {
      if (!frozen) throw Error('Freeze first');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.all([...pending]), new Promise<never>((_, reject) => { timer = setTimeout(() => { failed = Error('Pilot drain deadline; remote release uncertain'); reject(failed); }, deadlineMs); })]);
        if (failed || records.some(r => r.state === 'pending' || r.state === 'failed')) throw Error('Pilot normal completion unproven', {cause: failed});
      } finally { clearTimeout(timer); }
    },
  };
}
export async function resetPilot(options: {
  fence: ReturnType<typeof createPilotFence>; deadlineMs: number;
  dispose(): Promise<void>; evict(): Promise<void>; replace(): Promise<void>; acquire(): Promise<void>;
}) {
  options.fence.freeze();
  await options.fence.drain(options.deadlineMs);
  await options.dispose();
  await options.evict();
  await options.replace();
  await options.acquire();
}
export interface ReuseIdentity {
  location: string; modelConfig: string; pluginBytes: string; dependencies: string;
  environment: string; cwd: string; runtime: string;
}
export function pilotReuseAllowed(a: ReuseIdentity, b: ReuseIdentity) {
  return Object.keys(a).every(key => a[key as keyof ReuseIdentity] === b[key as keyof ReuseIdentity]);
}
