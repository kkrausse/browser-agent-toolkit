import { test, expect } from 'bun:test';
import { stripPreviewQuery, preservePreviewQuery } from '../scripts/preview-query';

test('preview transport preserves Vite flag spelling, duplicate keys and encoding', () => {
  expect(stripPreviewQuery('?url')).toBe('?url');
  expect(stripPreviewQuery('?raw&import&v=a%20b&v=c+d')).toBe('?raw&import&v=a%20b&v=c+d');
  expect(stripPreviewQuery('?url&__vv_listener=abc&__vv_host_paths=%5B%5D')).toBe('?url');
  expect(stripPreviewQuery('?__vv_listener=abc')).toBe('');
  expect(stripPreviewQuery('?%5F%5Fvv_listener=abc&url')).toBe('?url');
  expect(stripPreviewQuery('?bad%=x')).toBe('?bad%=x');
  const source = 'async function handlePreview(event, port, path, keepPrefix) { return new Response("ok"); }\nguestUrl.searchParams.delete("__vv_listener");\n  guestUrl.searchParams.delete("__vv_host_paths");';
  const run = new Function('guestUrl', preservePreviewQuery(source) + ';return guestUrl.href;');
  expect(run(new URL('http://localhost/src/style.css?url&__vv_listener=abc'))).toBe('http://localhost/src/style.css?url');
  expect(() => preservePreviewQuery('different upstream')).toThrow('boundary changed');
});

test('preview response policy is applied after untrusted response headers, including fallback responses', async () => {
  const source = 'async function handlePreview(event, port, path, keepPrefix) { return new Response("guest", { headers: { "Connection-Allowlist": "*" } }); }';
  const transport = 'guestUrl.searchParams.delete("__vv_listener");\n  guestUrl.searchParams.delete("__vv_host_paths");';
  const adapted = preservePreviewQuery(`${source}\n${transport}`).replace('/* trusted-preview-policy */ null', JSON.stringify('(response-origin); redirects=allow; webrtc=block'));
  const run = new Function('guestUrl', `${adapted}; return handlePreview({}, 5173, '/', false);`);
  const response = await run(new URL('http://localhost/preview/5173/')) as Response;
  expect(response.headers.get('Connection-Allowlist')).toBe('(response-origin); redirects=allow; webrtc=block');
  expect(await response.text()).toBe('guest');
});
