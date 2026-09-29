/** Strip transport-only keys without URLSearchParams reserializing Vite's ?url/?raw flags. */
export function stripPreviewQuery(search: string): string {
  const parts = search.replace(/^\?/, '').split('&').filter(part => {
    let key = part.split('=')[0]!;
    try { key = decodeURIComponent(key); } catch { /* preserve malformed user input */ }
    return key !== '__vv_listener' && key !== '__vv_host_paths';
  });
  return parts.length && parts.some(Boolean) ? '?' + parts.join('&') : '';
}

/** Versioned workspace delivery adapter for the upstream SW's reserved-query boundary. */
export function preservePreviewQuery(source: string): string {
  const before = 'guestUrl.searchParams.delete("__vv_listener");\n  guestUrl.searchParams.delete("__vv_host_paths");';
  if (!source.includes(before)) throw Error('Preview service-worker query boundary changed; review the workspace adapter');
  const entry = 'async function handlePreview(event, port, path, keepPrefix) {';
  if (!source.includes(entry)) throw Error('Preview response boundary changed; review the workspace adapter');
  return source.replace(before, `guestUrl.search = (${stripPreviewQuery.toString()})(guestUrl.search);`)
    .replace(entry, `// The serving application replaces this exact marker in the trusted SW script.
// A guest response or preview query cannot configure the policy.
const PREVIEW_CONNECTION_ALLOWLIST = /* trusted-preview-policy */ null;
async function handlePreview(event, port, path, keepPrefix) {
  const response = await handlePreviewUntrusted(event, port, path, keepPrefix);
  if (!PREVIEW_CONNECTION_ALLOWLIST) return response;
  const headers = new Headers(response.headers);
  headers.set('Connection-Allowlist', PREVIEW_CONNECTION_ALLOWLIST);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
async function handlePreviewUntrusted(event, port, path, keepPrefix) {`);
}
