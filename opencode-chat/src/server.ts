import { resolve, sep } from 'node:path';
import { authorizeEditorRequest, type EditorAuthorization } from '@kev-browser-agent-kit/workspace/server';

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

export function createBrowserEditorHandler(options: {
  authorize: EditorAuthorization;
  preparedDirectory: string;
  runtimeDirectory: string;
  clientDirectory?: string;
  base?: string;
  model: { baseURL: string; headers?: HeadersInit };
}) {
  const base = options.base ?? '/editor/';
  let privateAssets: Promise<string[]> | undefined;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url), path = url.pathname;
    const protectedAsset = options.clientDirectory && path.startsWith('/assets/') && (await (privateAssets ??= Bun.file(resolve(options.clientDirectory, 'editor-assets.json')).json())).includes(path);
    if (!path.startsWith(base) && !protectedAsset) return;
    const denied = await authorizeEditorRequest(request, options.authorize);
    if (denied) return denied;
    if (protectedAsset) {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
      const file = Bun.file(resolve(options.clientDirectory!, '.' + path));
      if (!await file.exists()) return new Response('Not found', { status: 404 });
      return new Response(request.method === 'HEAD' ? null : file, { headers: { ...browserEditorHeaders, 'Content-Type': file.type, 'Cache-Control': 'no-store' } });
    }
    if (path.startsWith(base + 'model/')) {
      if (!['GET', 'POST'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
      const upstreamBase = new URL(options.model.baseURL.replace(/\/$/, '') + '/');
      let modelPath: string;
      try { modelPath = decodeURIComponent(path.slice((base + 'model/').length)); } catch { return new Response('Invalid model path', { status: 400 }); }
      if (modelPath.includes('\\') || modelPath.split('/').some(part => part === '..' || part === '.')) return new Response('Invalid model path', { status: 400 });
      const upstream = new URL(upstreamBase.href + path.slice((base + 'model/').length) + url.search);
      if (upstream.origin !== upstreamBase.origin || !upstream.pathname.startsWith(upstreamBase.pathname)) return new Response('Invalid model path', { status: 400 });
      const headers = cleanHeaders(request.headers);
      for (const name of [...headers.keys()]) {
        if (['cookie', 'origin', 'referer', 'authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'forwarded'].includes(name) || name.startsWith('x-forwarded-') || name.startsWith('sec-')) headers.delete(name);
      }
      headers.set('accept-encoding', 'identity');
      new Headers(options.model.headers).forEach((value, key) => headers.set(key, value));
      try {
        const response = await fetch(upstream, { method: request.method, headers, body: request.body, signal: request.signal, redirect: 'manual' });
        const outgoing = cleanHeaders(response.headers);
        outgoing.delete('set-cookie'); outgoing.delete('content-encoding'); outgoing.set('cache-control', 'no-store');
        return new Response(response.body, { status: response.status, headers: outgoing });
      } catch { return new Response('Model upstream unavailable', { status: 502 }); }
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
}
