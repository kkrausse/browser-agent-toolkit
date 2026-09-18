import { expect, test } from 'bun:test';
import { decodeProjectFile, encodeProjectFile } from './project-file';

test('project delivery preserves binary assets and UTF-8 including a BOM', () => {
  for (const bytes of [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]),
    new TextEncoder().encode('\ufeffconst title = "café";'),
    Uint8Array.from({ length: 20000 }, (_, i) => i % 256)]) {
    const decoded = decodeProjectFile(encodeProjectFile(bytes));
    expect(typeof decoded === 'string' ? new TextEncoder().encode(decoded) : decoded).toEqual(bytes);
  }
});

test('existing text manifests remain compatible', () => {
  expect(encodeProjectFile(new TextEncoder().encode('hello'))).toBe('hello');
  expect(decodeProjectFile('hello')).toBe('hello');
});
