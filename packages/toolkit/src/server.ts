import { resolve, sep } from 'node:path';
import { decodeModelHeaders, MODEL_HEADERS } from './model-headers';
import { parseModelCatalog, type ModelCatalog } from './model-catalog';

export { parseModelCatalog, type ModelCatalog, type CatalogModel } from './model-catalog';

/** Read and validate a public model catalog file ({models, defaultModel}). Throws on any defect. */
export async function readModelCatalog(path: string): Promise<ModelCatalog> {
  const file = resolve(path);
  let document: unknown;
  try { document = await Bun.file(file).json(); }
  catch (cause) { throw Error(`Model catalog ${file} is not readable JSON`, { cause }); }
  try { return parseModelCatalog(document); }
  catch (cause) { throw Error(`Model catalog ${file} is invalid: ${(cause as Error).message}`, { cause }); }
}

/** Every page that hosts the editor, and everything it loads, needs these. */
export const editorHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Service-Worker-Allowed': '/',
} as const;

export interface ModelProvider {
  /** Requests under `<base>model/<id>/` are forwarded below this URL. */
  baseURL: string;
  /** Set on every forwarded request, over whatever the guest sent: `authorization`, `user-agent`. */
  headers?: HeadersInit;
}

export type EditorServerEvent =
  | { type: 'model.request'; id: string; provider: string; method: string; path: string }
  | { type: 'model.response'; id: string; provider: string; status: number; ms: number }
  | { type: 'model.failed'; id: string; provider: string; ms: number; error: string };

export interface EditorHandlerOptions {
  /** Output directory of `prepare()`. */
  preparedDir: string;
  /** URL prefix this handler owns. Default `/editor/`. */
  base?: string;
  /** Model providers by the id the guest configuration names (`opencode`). Keys stay here. */
  providers: Record<string, ModelProvider>;
  /** Public model catalog and default, delivered with the manifest. The editor then offers
   * only these models. Never a credential. Changing it needs no new preparation. */
  modelCatalog?: ModelCatalog;
  /** Built client directory of the host app. When it holds the `editor-assets.json` that the
   * Vite plugin emits, those chunks are served only through this handler (`matches` is true
   * for them), so the app's authorization covers them. */
  clientDir?: string;
  /** Model proxy activity: ids, status and timing only, never headers or bodies. Must not throw. */
  onEvent?(event: EditorServerEvent): void;
}

export interface EditorHandler {
  /** Whether this request is the editor's. The app authorizes, then calls `fetch`. */
  matches(request: Request): Promise<boolean>;
  /** Routing and delivery only: it assumes the app already decided to let the request through. */
  fetch(request: Request): Promise<Response>;
  /** Add to every other response of the app (the pages that host the editor). */
  headers: typeof editorHeaders;
}

function cleanHeaders(input: Headers) {
  const headers = new Headers(input);
  for (const name of [...(headers.get('connection')?.split(',') ?? []).map(s => s.trim()), 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']) headers.delete(name);
  return headers;
}

const credentialHeaders = ['cookie', 'origin', 'referer', 'authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'forwarded'];
/** A content hash in the file name: `image-3f9a…c2.bat`, `programs/opencode.1b22….js`. */
const contentAddressed = (path: string) => /(^|[./_-])[0-9a-f]{16,64}(?=[./_-])/.test(path.slice(path.lastIndexOf('/') + 1));
const plain = (body: string, status: number) => new Response(body, { status, headers: { ...editorHeaders, 'Cache-Control': 'no-store' } });

export function createEditorHandler(options: EditorHandlerOptions): EditorHandler {
  const base = options.base ?? '/editor/';
  if (!base.startsWith('/') || !base.endsWith('/')) throw Error('Editor base must start and end with "/"');
  const preparedRoot = resolve(options.preparedDir);
  // Fail at construction, not on a browser's first manifest request.
  const modelCatalog = options.modelCatalog && parseModelCatalog(options.modelCatalog);
  const event = (value: EditorServerEvent) => { try { options.onEvent?.(value); } catch { /* observer failure */ } };
  let privateAssets: Promise<string[]> | undefined;
  const isPrivateAsset = async (path: string) => !!options.clientDir
    && (await (privateAssets ??= Bun.file(resolve(options.clientDir, 'editor-assets.json')).json().catch(() => []))).includes(path);

  async function model(request: Request, url: URL): Promise<Response> {
    if (!['GET', 'POST'].includes(request.method)) return plain('Method not allowed', 405);
    const route = url.pathname.slice((base + 'model/').length);
    const separator = route.indexOf('/');
    const providerID = separator < 0 ? route : route.slice(0, separator);
    const provider = Object.hasOwn(options.providers, providerID) ? options.providers[providerID] : undefined;
    if (!provider) return plain('Unknown model provider', 404);
    const nativePath = separator < 0 ? '' : route.slice(separator + 1);
    const upstreamBase = new URL(provider.baseURL.replace(/\/$/, '') + '/');
    let modelPath: string;
    try { modelPath = decodeURIComponent(nativePath); } catch { return plain('Invalid model path', 400); }
    if (modelPath.includes('\\') || modelPath.split('/').some(part => part === '..' || part === '.')) return plain('Invalid model path', 400);
    const upstream = new URL(upstreamBase.href + nativePath + url.search);
    if (upstream.origin !== upstreamBase.origin || !upstream.pathname.startsWith(upstreamBase.pathname)) return plain('Invalid model path', 400);
    // Chromium rewrites the guest's request headers (user-agent, origin, sec-*), so the
    // guest packs the ones it really sent into one header. Only those are forwarded.
    let headers: Headers;
    try { headers = cleanHeaders(decodeModelHeaders(request.headers.get(MODEL_HEADERS))); }
    catch { return plain('Invalid model header envelope', 400); }
    for (const name of [...headers.keys()]) {
      if (credentialHeaders.includes(name) || name.startsWith('x-forwarded-') || name.startsWith('sec-') || name.startsWith('x-editor-')) headers.delete(name);
    }
    headers.delete('accept-encoding');
    new Headers(provider.headers).forEach((value, key) => headers.set(key, value));
    const started = performance.now(), id = crypto.randomUUID();
    const elapsed = () => Math.round(performance.now() - started);
    event({ type: 'model.request', id, provider: providerID, method: request.method, path: upstream.pathname });
    try {
      const response = await fetch(new Request(upstream, { method: request.method, headers, body: request.body, signal: request.signal, redirect: 'manual' }));
      event({ type: 'model.response', id, provider: providerID, status: response.status, ms: elapsed() });
      const outgoing = cleanHeaders(response.headers);
      outgoing.delete('set-cookie'); outgoing.delete('content-encoding'); outgoing.set('cache-control', 'no-store');
      return new Response(response.body, { status: response.status, headers: outgoing });
    } catch (error) {
      event({ type: 'model.failed', id, provider: providerID, ms: elapsed(), error: error instanceof Error ? error.message : String(error) });
      return plain('Model upstream unavailable', 502);
    }
  }

  async function file(request: Request, path: string, cache: string): Promise<Response> {
    const source = Bun.file(path);
    if (!await source.exists() || !(await source.stat()).isFile()) return plain('Not found', 404);
    const stat = await source.stat();
    const etag = `"${stat.size.toString(36)}-${Math.round(stat.mtimeMs).toString(36)}"`;
    const headers = new Headers({ ...editorHeaders, 'Content-Type': source.type || 'application/octet-stream', 'Cache-Control': cache, 'Accept-Ranges': 'bytes', ETag: etag });
    if (cache !== 'no-store' && request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
    // The image is large: a client may fetch it in parts or resume a broken download.
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
    if (range && (range[1] || range[2]) && (!request.headers.has('if-range') || request.headers.get('if-range') === etag)) {
      const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) return new Response(null, { status: 416, headers: { ...Object.fromEntries(headers), 'Content-Range': `bytes */${stat.size}` } });
      headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      headers.set('Content-Length', String(end - start + 1));
      return new Response(request.method === 'HEAD' ? null : source.slice(start, end + 1), { status: 206, headers });
    }
    // Precompressed sibling written at prepare time; never for a range.
    const accepts = request.headers.get('accept-encoding') ?? '';
    for (const [encoding, extension] of [['zstd', '.zst'], ['br', '.br']] as const) {
      if (range || !new RegExp(`(^|[,\\s])${encoding}([,;\\s]|$)`).test(accepts)) continue;
      const compressed = Bun.file(path + extension);
      if (!await compressed.exists()) continue;
      headers.set('Content-Encoding', encoding); headers.set('Vary', 'Accept-Encoding'); headers.delete('Accept-Ranges');
      return new Response(request.method === 'HEAD' ? null : compressed, { headers });
    }
    headers.set('Content-Length', String(stat.size));
    return new Response(request.method === 'HEAD' ? null : source, { headers });
  }

  return {
    headers: editorHeaders,
    async matches(request) {
      const path = new URL(request.url).pathname;
      return path.startsWith(base) || await isPrivateAsset(path);
    },
    async fetch(request) {
      const url = new URL(request.url), path = url.pathname;
      if (!path.startsWith(base)) {
        if (!await isPrivateAsset(path)) return plain('Not found', 404);
        if (!['GET', 'HEAD'].includes(request.method)) return plain('Method not allowed', 405);
        return file(request, resolve(options.clientDir!, '.' + path), 'no-store');
      }
      if (path.startsWith(base + 'model/')) return model(request, url);
      if (!['GET', 'HEAD'].includes(request.method)) return plain('Method not allowed', 405);
      let relative: string;
      try { relative = decodeURIComponent(path.slice(base.length)); } catch { return plain('Bad path', 400); }
      const target = resolve(preparedRoot, relative);
      if (!target.startsWith(preparedRoot + sep) || relative.includes('\0')) return plain('Not found', 404);
      if (relative === 'manifest.json') {
        const source = Bun.file(target);
        if (!await source.exists()) return plain('The editor is not prepared; run prepare first', 404);
        const manifest = await source.json();
        const body = modelCatalog ? { ...manifest, modelCatalog: modelCatalog.models, defaultModel: modelCatalog.defaultModel } : manifest;
        const response = Response.json(body, { headers: { ...editorHeaders, 'Cache-Control': 'no-store' } });
        return request.method === 'HEAD' ? new Response(null, { headers: response.headers }) : response;
      }
      return file(request, target, contentAddressed(relative) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  };
}
