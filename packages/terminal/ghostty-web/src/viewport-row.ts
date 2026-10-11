import type { IRenderable, IScrollbackProvider } from './renderer-interface';
import type { GhosttyCell } from './types';

/** One accessor per paint pass, sharing the already-fetched screen cell pool. */
export function createViewportRowAccessor(
  buffer: IRenderable,
  cells: GhosttyCell[] | null,
  dims: { cols: number; rows: number },
  viewportY: number,
  scrollbackLength: number,
  scrollbackProvider?: IScrollbackProvider
) {
  // Compare and index in the same coordinate system. At offset 1.5, row 1
  // is screen row 0, not scrollback[scrollbackLength] (which does not exist).
  const offset = Math.max(0, Math.floor(viewportY));
  return (y: number): { src: GhosttyCell[]; base: number; count: number } | null => {
    if (y < offset && scrollbackProvider) {
      const line = scrollbackProvider.getScrollbackLine(scrollbackLength - offset + y);
      return line ? { src: line, base: 0, count: line.length } : null;
    }
    const screenRow = y - offset;
    if (screenRow < 0 || screenRow >= dims.rows) return null;
    if (cells) return { src: cells, base: screenRow * dims.cols, count: dims.cols };
    const line = buffer.getLine(screenRow);
    return line ? { src: line, base: 0, count: line.length } : null;
  };
}
