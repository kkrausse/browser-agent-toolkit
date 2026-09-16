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
  return source.replace(before, `guestUrl.search = (${stripPreviewQuery.toString()})(guestUrl.search);`);
}
