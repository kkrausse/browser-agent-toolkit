import { expect, test } from 'bun:test';
import { UrlRegexProvider } from './url-regex-provider';
import type { ILink } from '../types';

function linksAt(rows: string[], wrapped: number[], y: number) {
  const lines = rows.map((text, row) => {
    const cells = [...text].flatMap(char => char === '界'
      ? [{ getCodepoint: () => char.codePointAt(0)!, getWidth: () => 2 }, { getCodepoint: () => 0, getWidth: () => 0 }]
      : [{ getCodepoint: () => char.codePointAt(0)!, getWidth: () => 1 }]);
    return { length: cells.length, isWrapped: wrapped.includes(row), getCell: (x: number) => cells[x] };
  });
  const provider = new UrlRegexProvider({ buffer: { active: { getLine: row => lines[row] } } });
  let links: ILink[] | undefined;
  provider.provideLinks(y, result => { links = result; });
  return links;
}

test('every row of a soft-wrapped URL resolves the complete URL and range', () => {
  const rows = ['https://example.', 'com/a/long/path?', 'token=123. rest '];
  for (let y = 0; y < 3; y++) {
    expect(linksAt(rows, [1, 2], y)?.[0]).toMatchObject({
      text: 'https://example.com/a/long/path?token=123',
      range: { start: { x: 0, y: 0 }, end: { x: 8, y: 2 } },
    });
  }
});

test('hard line breaks do not append unrelated text to a URL', () => {
  const rows = ['https://example.com', '/not-a-continuation'];
  expect(linksAt(rows, [], 0)?.[0]?.text).toBe(rows[0]);
  expect(linksAt(rows, [], 1)).toBeUndefined();
});

test('wide and astral characters before a URL preserve cell coordinates', () => {
  expect(linksAt(['界😀 https://example.com'], [], 0)?.[0]?.range).toEqual({
    start: { x: 4, y: 0 }, end: { x: 22, y: 0 },
  });
});

test('wrapped prose on a subsequent row is not a link', () => {
  expect(linksAt(['https://example.com ', 'ordinary words     '], [1], 1)).toBeUndefined();
});
