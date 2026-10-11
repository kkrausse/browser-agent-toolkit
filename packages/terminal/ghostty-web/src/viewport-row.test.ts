import { describe, expect, test } from 'bun:test';
import { createViewportRowAccessor } from './viewport-row';
import type { IRenderable } from './renderer-interface';
import type { GhosttyCell } from './types';

describe('shared Canvas/WebGL viewport row mapping', () => {
  for (const pooled of [true, false]) {
    for (const offset of [0, 0.5, 1, 1.5, 2.99, 3]) {
      test(`offset ${offset}, pooled=${pooled}: no gap at scrollback/screen boundary`, () => {
        const cell = (codepoint: number) => ({ codepoint }) as GhosttyCell;
        const history = [[cell(10)], [cell(11)], [cell(12)]];
        const screen = [[cell(20)], [cell(21)], [cell(22)]];
        const screenReads: number[] = [];
        const historyReads: number[] = [];
        const buffer = {
          getLine(y: number) { screenReads.push(y); return screen[y] ?? null; },
        } as IRenderable;
        const rowAt = createViewportRowAccessor(
          buffer, pooled ? screen.flat() : null, { cols: 1, rows: 3 }, offset, 3,
          {
            getScrollbackLength: () => 3,
            getScrollbackLine(y) { historyReads.push(y); return history[y] ?? null; },
          }
        );
        const visible = [0, 1, 2].map(y => {
          const row = rowAt(y);
          return row?.src[row.base].codepoint;
        });
        const integer = Math.floor(offset);
        expect(visible).toEqual([...history.slice(3 - integer), ...screen]
          .slice(0, 3).map(line => line[0].codepoint));
        expect(historyReads.every(y => Number.isInteger(y) && y >= 0 && y < 3)).toBe(true);
        if (pooled) expect(screenReads).toEqual([]);
      });
    }
  }
});
