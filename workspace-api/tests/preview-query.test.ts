import { test, expect } from 'bun:test';
import { stripPreviewQuery, preservePreviewQuery } from '../scripts/preview-query';

test('preview transport preserves Vite flag spelling, duplicate keys and encoding', () => {
  expect(stripPreviewQuery('?url')).toBe('?url');
  expect(stripPreviewQuery('?raw&import&v=a%20b&v=c+d')).toBe('?raw&import&v=a%20b&v=c+d');
  expect(stripPreviewQuery('?url&__vv_listener=abc&__vv_host_paths=%5B%5D')).toBe('?url');
  expect(stripPreviewQuery('?__vv_listener=abc')).toBe('');
  expect(stripPreviewQuery('?%5F%5Fvv_listener=abc&url')).toBe('?url');
  expect(stripPreviewQuery('?bad%=x')).toBe('?bad%=x');
  const source = 'guestUrl.searchParams.delete("__vv_listener");\n  guestUrl.searchParams.delete("__vv_host_paths");';
  const run = new Function('guestUrl', preservePreviewQuery(source) + ';return guestUrl.href;');
  expect(run(new URL('http://localhost/src/style.css?url&__vv_listener=abc'))).toBe('http://localhost/src/style.css?url');
  expect(() => preservePreviewQuery('different upstream')).toThrow('boundary changed');
});
