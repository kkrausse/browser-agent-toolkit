/** Bounded native-header transport. The outer request belongs to app auth. */
export const MODEL_HEADERS = 'x-editor-model-headers';
export const MAX_MODEL_HEADERS = 8192;

export function encodeModelHeaders(headers: Headers): string {
  const value = btoa(JSON.stringify([...headers]));
  if (value.length > MAX_MODEL_HEADERS) throw Error('Model headers exceed transport limit');
  return value;
}

export function decodeModelHeaders(value: string | null): Headers {
  if (!value || value.length > MAX_MODEL_HEADERS || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw Error('Invalid model header envelope');
  const entries: unknown = JSON.parse(atob(value));
  if (!Array.isArray(entries) || entries.length > 64) throw Error('Invalid model header map');
  const headers = new Headers();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string'
      || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(entry[0]) || /[^\x20-\x7e\x80-\xff]/.test(entry[1])
      || headers.has(entry[0]) || entry[0] === MODEL_HEADERS) throw Error('Invalid model header entry');
    headers.set(entry[0], entry[1]);
  }
  return headers;
}

/** Self-contained JS for OpenCode's public global single-file plugin discovery. */
export function modelHeaderPluginSource(modelBaseURL: string): string {
  const base = new URL(modelBaseURL);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/'))
    throw Error('Expected credential-free HTTP model proxy directory URL');
  return `export default { id: 'editor.model-headers', async setup(ctx) {
  await ctx.session.hook('http.request', event => {
    const destination = new URL(event.request.url);
    if (destination.origin !== ${JSON.stringify(base.origin)} || destination.username || destination.password
      || !destination.pathname.startsWith(${JSON.stringify(base.pathname)})) throw Error('Unexpected editor model destination');
    const headers = event.request.headers;
    const envelope = btoa(JSON.stringify([...headers]));
    if (envelope.length > ${MAX_MODEL_HEADERS}) throw Error('Model headers exceed transport limit');
    for (const name of [...headers.keys()]) headers.delete(name);
    headers.set(${JSON.stringify(MODEL_HEADERS)}, envelope);
  }, { providerID: 'opencode' });
} };`;
}
