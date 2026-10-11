/**
 * The renderer seam.
 *
 * Everything outside the paint layer (Terminal, SelectionManager, FitAddon,
 * link hover) talks to a renderer only through this surface, so a backend is a
 * drop-in. CanvasRenderer and WebglRenderer both implement it.
 */

import type { FontMetrics } from './font-metrics';
import type { ITheme } from './interfaces';
import type { SelectionManager } from './selection-manager';
import type { GhosttyCell } from './types';

/** Terminal state the renderer reads. Implemented by GhosttyTerminal. */
export interface IRenderable {
  getLine(y: number): GhosttyCell[] | null;
  getCursor(): { x: number; y: number; visible: boolean };
  getDimensions(): { cols: number; rows: number };
  isRowDirty(y: number): boolean;
  /** Returns true if a full redraw is needed (e.g., screen change) */
  needsFullRedraw?(): boolean;
  clearDirty(): void;
  /**
   * Pooled full-viewport cell array (rows*cols, row-major), refreshed on call.
   * When present, the renderer fetches it ONCE per render pass instead of
   * calling getLine() per row — getLine() re-extracts the entire viewport
   * from WASM on every call, which made per-row fetching O(rows * cells).
   * The array is a reused pool: valid until the next getViewport()/resize.
   */
  getViewport?(): GhosttyCell[];
  /** True when terminal state changed since the last clearDirty(). */
  isDirty?(): boolean;
  /**
   * Get the full grapheme string for a cell at (row, col).
   * For cells with grapheme_len > 0, this returns all codepoints combined.
   * For simple cells, returns the single character.
   */
  getGraphemeString?(row: number, col: number): string;
}

export interface IScrollbackProvider {
  getScrollbackLine(offset: number): GhosttyCell[] | null;
  getScrollbackLength(): number;
}

export interface ITerminalRenderer {
  render(
    buffer: IRenderable,
    forceAll?: boolean,
    viewportY?: number,
    scrollbackProvider?: IScrollbackProvider,
    scrollbarOpacity?: number
  ): void;
  resize(cols: number, rows: number): void;
  remeasureFont(): void;
  setTheme(theme: ITheme): void;
  setFontSize(size: number): void;
  setFontFamily(family: string): void;
  setCursorStyle(style: 'block' | 'underline' | 'bar'): void;
  setCursorBlink(enabled: boolean): void;
  resetCursorBlink(): void;
  setSelectionManager(manager: SelectionManager): void;
  setHoveredHyperlinkId(hyperlinkId: number): void;
  setHoveredLinkRange(
    range: { startX: number; startY: number; endX: number; endY: number } | null
  ): void;
  getMetrics(): FontMetrics;
  getCanvas(): HTMLCanvasElement;
  readonly charWidth: number;
  readonly charHeight: number;
  clear(): void;
  dispose(): void;
}
