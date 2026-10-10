import { expect, test } from 'bun:test';
import { blockElementRects } from './block-elements';

test('complementary blocks tile odd-sized device cells without overlaps or gaps', () => {
  for (const [a, b] of [['▀', '▄'], ['▌', '▐'], ['▚', '▞']]) {
    for (const [width, height] of [[9, 19], [10, 20], [13, 27]]) {
      const pixels = new Uint8Array(width * height);
      for (const ch of [a, b]) {
        for (const [left, top, right, bottom] of blockElementRects(ch.charCodeAt(0))!) {
          for (let y = Math.round(top * height / 8); y < Math.round(bottom * height / 8); y++) {
            for (let x = Math.round(left * width / 8); x < Math.round(right * width / 8); x++) pixels[y * width + x]++;
          }
        }
      }
      expect([...pixels].every(value => value === 1)).toBe(true);
    }
  }
});

test('full block covers the cell and unsupported shapes retain font rendering', () => {
  expect(blockElementRects(0x2588)).toEqual([[0, 0, 8, 8]]);
  for (const ch of ['A', '─', '░', '▒', '▓']) expect(blockElementRects(ch.charCodeAt(0))).toBeNull();
});
