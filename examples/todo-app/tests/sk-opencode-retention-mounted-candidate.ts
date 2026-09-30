import {createChatController} from '../../../opencode-chat/src/controller';

// Browser-bundleable qualification candidate; caller owns the NEW isolated host,
// runtime and endpoint. No autostart, global fetch, eviction or workspace writes.
// A successful mount is not an accepted retention transition.
export async function qualifyMountedRetentionCandidate(options: {
  endpoint: {url: string; fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>};
  generation: string;
  previousSessionIDs: readonly string[];
  readSourceMarker(): Promise<string>;
  verifyOwnedIdentity(): Promise<void>;
  // Must run the pinned 2.0.3 HttpApi decode/encode status/header/body parity
  // check, not a current-doc SDK codec or a permissive JSON shape check.
  verifyPinnedCodec(record: {method: string; path: string; status: number; headers: [string, string][]; body: Uint8Array}): Promise<void>;
  requestMs: number;
  render(snapshot: ReturnType<ReturnType<typeof createChatController>['getSnapshot']>): void;
}) {
  let frozen = false;
  let failure: unknown;
  const pending = new Set<Promise<unknown>>();
  const wire: {method: string; path: string; status: number; headers: [string, string][]; bodyBase64: string; sha256: string}[] = [];
  const endpoint = new URL(options.endpoint.url);
  const requestURL = (path: string) => {
    const url = new URL(path.replace(/^\//, ''), endpoint);
    for (const [key, value] of endpoint.searchParams) url.searchParams.set(key, value);
    url.searchParams.set('location[directory]', '/workspace');
    return url.href;
  };
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (frozen || failure) return Promise.reject(Error('Mounted candidate admission closed'));
    const request = new Request(input, init);
    const url = new URL(request.url);
    const basePath = endpoint.pathname.endsWith('/') ? endpoint.pathname : endpoint.pathname + '/';
    const path = '/' + url.pathname.slice(basePath.length);
    const directory = url.searchParams.get('location[directory]') ?? request.headers.get('x-opencode-directory');
    const sse = request.method === 'GET' && path === '/api/event';
    const sessionRead = /^\/api\/session\/[A-Za-z0-9_-]+(?:\/(message|permission|form))?$/.test(path);
    const allowed = request.method === 'GET' && (['/api/health', '/api/plugin', '/api/config', '/api/model', '/api/model/default', '/api/project/current', '/api/session', '/api/session/active'].includes(path) || sessionRead || sse)
      || request.method === 'POST' && ['/api/session', '/api/plugin/await-activation'].includes(path);
    if (url.origin !== endpoint.origin || !url.pathname.startsWith(basePath) || !allowed ||
      (!sse && directory !== '/workspace') || url.searchParams.has('location[workspace]') || request.headers.has('x-opencode-workspace')) {
      failure = Error('Mounted candidate route/ownership rejected');
      return Promise.reject(failure);
    }
    const task = Promise.resolve().then(async () => {
      request.signal.throwIfAborted();
      const response = await options.endpoint.fetch(request.url, {method: request.method, headers: request.headers, signal: request.signal,
        ...(request.body ? {body: new Uint8Array(await request.arrayBuffer())} : {})});
      if (!response.ok) throw Error('Candidate HTTP ' + response.status);
      if (sse) return response; // Global SSE local cancellation is joined by dispose.
      const body = new Uint8Array(await response.arrayBuffer());
      request.signal.throwIfAborted();
      const headers: [string, string][] = [...response.headers];
      await options.verifyPinnedCodec({method: request.method, path, status: response.status, headers, body});
      let binary = '';
      for (let offset = 0; offset < body.length; offset += 8192) binary += String.fromCharCode(...body.subarray(offset, offset + 8192));
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', body)), byte => byte.toString(16).padStart(2, '0')).join('');
      wire.push({method: request.method, path, status: response.status, headers, bodyBase64: btoa(binary), sha256});
      return new Response(response.status === 204 ? null : body, {status: response.status, headers: response.headers});
    }).catch(error => { failure ??= error; throw error; });
    pending.add(task);
    return task.finally(() => { pending.delete(task); });
  };
  const json = async (path: string) => (await fetch(requestURL(path), {signal: AbortSignal.timeout(options.requestMs)})).json();
  await options.verifyOwnedIdentity();
  const health = await json('/api/health');
  if (health.version !== '2.0.3' || health.healthy !== true) throw Error('Pinned health missing');
  await fetch(requestURL('/api/plugin/await-activation'), {method: 'POST', signal: AbortSignal.timeout(options.requestMs)});
  const project = await json('/api/project/current');
  const controller = createChatController({endpoint: {url: requestURL(''), fetch}, directory: '/workspace', startNewSession: true, handshakeTimeoutMs: options.requestMs});
  const unsubscribe = controller.subscribe(() => options.render(controller.getSnapshot()));
  try {
    await controller.ready;
    const snapshot = controller.getSnapshot();
    options.render(snapshot);
    if (snapshot.error || snapshot.loading || !snapshot.sessionID || snapshot.messages.length || snapshot.execution !== 'idle' || snapshot.permissions.length || snapshot.questions.length) throw Error('Fresh idle hydrated root missing');
    if (options.previousSessionIDs.includes(snapshot.sessionID)) throw Error('Old selected session reused');
    const session = (await json('/api/session/' + snapshot.sessionID)).data;
    if (session.id !== snapshot.sessionID || session.projectID !== project.id || session.location?.directory !== '/workspace' ||
      session.location?.workspaceID !== undefined || session.parentID !== undefined || session.fork !== undefined ||
      session.model !== undefined || session.metadata !== undefined || session.permissions !== undefined) throw Error('Root inheritance/location mismatch');
    if ((await options.readSourceMarker()) !== options.generation) throw Error('Source generation marker mismatch');
    await options.verifyOwnedIdentity();
    frozen = true;
    await Promise.all([...pending]);
    unsubscribe();
    await controller.dispose();
    if (failure) throw failure;
    return {status: 'mounted-qualification-only' as const, retentionAccepted: false as const,
      remoteProof: false as const, generation: options.generation, health, project, session, snapshot, wire};
  } catch (error) {
    frozen = true;
    unsubscribe();
    // Join local ownership only. No remote eviction, source replacement or retry.
    await controller.dispose();
    throw error;
  }
}
