import { resolve, sep } from 'node:path';
import { createDiagnosticScope, type DiagnosticScope } from '@kev-browser-agent-kit/workspace/diagnostics';
import { handleDiagnosticRequest, editorModelError, type DiagnosticContext, type EditorDiagnosticSink } from './diagnostics-server';
export { createFileDiagnosticSink, runEditorLogs, readEditorDiagnostics, type EditorDiagnosticSink } from './diagnostics-server';

export const browserEditorHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Service-Worker-Allowed': '/',
};

function cleanHeaders(input: Headers) {
  const headers = new Headers(input);
  for (const name of [...(headers.get('connection')?.split(',') ?? []).map(s => s.trim()), 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']) headers.delete(name);
  return headers;
}

/** Routing and delivery only. The application must authorize before calling fetch. */
export function createBrowserEditorHandler(options: {
  preparedDirectory: string;
  runtimeDirectory: string;
  clientDirectory?: string;
  base?: string;
  providers: Record<string, { baseURL: string; headers?: HeadersInit }>;
  diagnostics?: EditorDiagnosticSink;
  /** Invoked for the manifest after app authorization. Receives the request's diagnostic scope. */
  prepare?(diagnostics: DiagnosticScope): Promise<void>;
}) {
  const base = options.base ?? '/editor/';
  const scope = (context: DiagnosticContext = {}, runId?: string) => createDiagnosticScope(options.diagnostics?.enabled ? event => {
    void Promise.resolve().then(() => options.diagnostics!.write({ clientId: 'server', events: [event] }, context)).catch(error => console.error('Editor diagnostic sink failed', error));
  } : undefined, runId);
  let privateAssets: Promise<string[]> | undefined;
  const isPrivateAsset = async (path: string) => !!options.clientDirectory && path.startsWith('/assets/')
    && (await (privateAssets ??= Bun.file(resolve(options.clientDirectory, 'editor-assets.json')).json())).includes(path);
  const matches = async (request: Request): Promise<boolean> => {
    const path = new URL(request.url).pathname;
    return path.startsWith(base) || await isPrivateAsset(path);
  };
  const handle = async (request: Request, context: DiagnosticContext = {}): Promise<Response | undefined> => {
    const url = new URL(request.url), path = url.pathname;
    const protectedAsset = await isPrivateAsset(path);
    if (!path.startsWith(base) && !protectedAsset) return;
    if (path === base + 'diagnostics/config') return Response.json({ enabled: options.diagnostics?.enabled === true }, { headers: { 'Cache-Control': 'no-store' } });
    if (path === base + 'diagnostics') return handleDiagnosticRequest(request, options.diagnostics, context);
    const requestedRun = request.headers.get('x-editor-run-id');
    const diagnostics = scope(context, requestedRun && /^[\w.-]{1,128}$/.test(requestedRun) ? requestedRun : undefined);
    if (path === base + 'prepared/manifest.json' && ['GET', 'HEAD'].includes(request.method) && options.prepare) {
      try { await diagnostics.stage('preparation', () => options.prepare!(diagnostics)); }
      catch { return new Response('Editor preparation failed; see editor diagnostics and retry', { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
    }
    if (protectedAsset) {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
      const file = Bun.file(resolve(options.clientDirectory!, '.' + path));
      if (!await file.exists()) return new Response('Not found', { status: 404 });
      return new Response(request.method === 'HEAD' ? null : file, { headers: { ...browserEditorHeaders, 'Content-Type': file.type, 'Cache-Control': 'no-store' } });
    }
    if (path.startsWith(base + 'model/')) {
      if (!['GET', 'POST'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
      const route = path.slice((base + 'model/').length);
      const separator = route.indexOf('/');
      const providerID = separator < 0 ? route : route.slice(0, separator);
      const provider = Object.hasOwn(options.providers, providerID) ? options.providers[providerID] : undefined;
      if (!provider) return new Response('Unknown model provider', { status: 404 });
      const nativePath = separator < 0 ? '' : route.slice(separator + 1);
      const upstreamBase = new URL(provider.baseURL.replace(/\/$/, '') + '/');
      let modelPath: string;
      try { modelPath = decodeURIComponent(nativePath); } catch { return new Response('Invalid model path', { status: 400 }); }
      if (modelPath.includes('\\') || modelPath.split('/').some(part => part === '..' || part === '.')) return new Response('Invalid model path', { status: 400 });
      const upstream = new URL(upstreamBase.href + nativePath + url.search);
      if (upstream.origin !== upstreamBase.origin || !upstream.pathname.startsWith(upstreamBase.pathname)) return new Response('Invalid model path', { status: 400 });
      const headers = cleanHeaders(request.headers);
      for (const name of [...headers.keys()]) {
        if (['cookie', 'origin', 'referer', 'authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'forwarded'].includes(name) || name.startsWith('x-forwarded-') || name.startsWith('sec-')) headers.delete(name);
      }
      headers.set('accept-encoding', 'identity');
      new Headers(provider.headers).forEach((value, key) => headers.set(key, value));
      headers.delete('x-editor-run-id');
      const started = performance.now();
      diagnostics.record('model.request', { path, provider: providerID, sessionId: request.headers.get('x-opencode-session') });
      try {
        const response = await fetch(upstream, { method: request.method, headers, body: request.body, signal: request.signal, redirect: 'manual' });
        const detail = { path, provider: providerID, status: response.status, elapsedMs: Math.round(performance.now() - started), retryAfter: response.headers.get('retry-after'),
          userAgent: headers.get('user-agent'), providerCredentialConfigured: ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key'].some(name => headers.has(name)), sessionId: request.headers.get('x-opencode-session') };
        diagnostics.record('model.response', detail);
        if (options.diagnostics?.enabled && !response.ok) void editorModelError(response).then(error => diagnostics.record('model.error', { ...detail, error }));
        const outgoing = cleanHeaders(response.headers);
        outgoing.delete('set-cookie'); outgoing.delete('content-encoding'); outgoing.set('cache-control', 'no-store');
        return new Response(response.body, { status: response.status, headers: outgoing });
      } catch (error) { diagnostics.record('model.failed', { path, elapsedMs: Math.round(performance.now() - started), error }); return new Response('Model upstream unavailable', { status: 502 }); }
    }
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
    for (const [prefix, directory] of [['prepared/', options.preparedDirectory], ['runtime/', options.runtimeDirectory]]) {
      if (!path.startsWith(base + prefix)) continue;
      const root = resolve(directory!);
      let relative: string;
      try { relative = decodeURIComponent(path.slice((base + prefix).length)); } catch { return new Response('Bad path', { status: 400 }); }
      const filePath = resolve(root, relative);
      if (!filePath.startsWith(root + sep) || relative.includes('\0')) return new Response('Not found', { status: 404 });
      const file = Bun.file(filePath);
      if (await file.exists() && (await file.stat()).isFile()) return new Response(request.method === 'HEAD' ? null : file, { headers: { ...browserEditorHeaders, 'Content-Type': file.type, 'Cache-Control': 'no-store' } });
    }
    return new Response('Not found', { status: 404 });
  };
  return { matches, fetch: handle, diagnostic: (event: string, data?: unknown, context?: DiagnosticContext) => scope(context).record(event, data) };
}
