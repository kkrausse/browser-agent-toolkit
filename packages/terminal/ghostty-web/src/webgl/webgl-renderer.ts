/**
 * WebGL2 terminal renderer.
 *
 * Structural difference from CanvasRenderer: nothing is painted per cell per
 * frame. Each cell owns fixed instance slots (one background rect, one glyph,
 * two decoration rects) in persistent GPU buffers; a repaint rewrites only the
 * rows whose content changed and re-issues ~6 draw calls for the whole screen.
 * A full-screen repaint therefore costs one buffer upload plus a few draws
 * instead of ~440 Canvas2D calls per row.
 *
 * Consequences of drawing the whole frame every time, all of them
 * simplifications relative to the Canvas2D path:
 * - no adjacent-row repaint for glyph overflow (glyph quads carry their own ink
 *   box and are drawn after every background),
 * - no scrollbar "heal" pass (the strip never damages cell pixels),
 * - no cursor-row invalidation (the cursor is an overlay batch).
 *
 * Draw order, fixed by Kitty graphics semantics (see image-pass.ts):
 *   clear -> backgrounds -> images(z<0) -> glyphs -> underlines/strikethrough
 *   -> images(z>=0) -> cursor -> scrollbar
 */

import { type FontMetrics, measureFontMetrics } from '../font-metrics';
import type { ITheme } from '../interfaces';
import type { IRenderable, IScrollbackProvider, ITerminalRenderer } from '../renderer-interface';
import type { SelectionManager } from '../selection-manager';
import { DEFAULT_THEME } from '../theme';
import type { GhosttyCell } from '../types';
import { CellFlags } from '../types';
import { createViewportRowAccessor } from '../viewport-row';
import { type Rgba, parseColor } from './color';
import { blockElementRects } from './block-elements';
import { GlyphAtlas, GlyphStyle } from './glyph-atlas';
import { GlyphPass, createGlyphProgram } from './glyph-pass';
import { ImagePass, type ImagePlacement } from './image-pass';
import { RectPass, createRectProgram } from './rect-pass';

export interface WebglRendererOptions {
  fontSize?: number;
  fontFamily?: string;
  cursorStyle?: 'block' | 'underline' | 'bar';
  cursorBlink?: boolean;
  theme?: ITheme;
  devicePixelRatio?: number;
}

/** Hover underline color, matching CanvasRenderer. */
const LINK_COLOR: Rgba = { r: 0x4a / 255, g: 0x90 / 255, b: 0xe2 / 255, a: 1 };

/** Overlay rect slots: cursor first, then scrollbar track and thumb. */
const OVERLAY_CURSOR = 0;
const OVERLAY_SCROLLBAR_TRACK = 1;
const OVERLAY_SCROLLBAR_THUMB = 2;
const OVERLAY_RECT_COUNT = 3;

export class WebglRenderer implements ITerminalRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private contextLost = false;

  private fontSize: number;
  private fontFamily: string;
  private cursorStyle: 'block' | 'underline' | 'bar';
  private cursorBlink: boolean;
  private theme: Required<ITheme>;
  private devicePixelRatio: number;
  private metrics: FontMetrics;

  // Theme colors, parsed once per setTheme.
  private bgColor: Rgba = { r: 0, g: 0, b: 0, a: 1 };
  private cursorColor: Rgba = { r: 1, g: 1, b: 1, a: 1 };
  private cursorAccentColor: Rgba = { r: 0, g: 0, b: 0, a: 1 };
  private selectionBgColor: Rgba = { r: 1, g: 1, b: 1, a: 1 };
  private selectionFgColor: Rgba = { r: 0, g: 0, b: 0, a: 1 };

  private atlas: GlyphAtlas;
  private atlasGeneration = 0;
  /** Shared by the passes, so only this class can delete them. */
  private programs: WebGLProgram[] = [];
  private bgRects: RectPass;
  private decoRects: RectPass;
  private glyphs: GlyphPass;
  private overlayRects: RectPass;
  private cursorGlyph: GlyphPass;
  private images: ImagePass;
  private placements: ImagePlacement[] = [];
  private placementsDirty = false;

  // Grid geometry in device pixels. Column/row boundaries are rounded so
  // adjacent background rects tile without seams at fractional DPR.
  private cols = 0;
  private rows = 0;
  private colX = new Int32Array(1);
  private rowY = new Int32Array(1);
  private cellWidthDevice = 1;
  private cellHeightDevice = 1;

  private cursorVisible = true;
  /** Scissor rect for the block cursor's accent glyph, device px, y-down. */
  private cursorClip: { x: number; y: number; w: number; h: number } | null = null;
  private cursorBlinkInterval?: number;
  private lastCursorPosition = { x: 0, y: 0 };
  private lastViewportY = 0;

  private currentBuffer: IRenderable | null = null;
  private currentCells: GhosttyCell[] | null = null;
  private currentCols = 0;
  private currentSelectionCoords: {
    startCol: number;
    startRow: number;
    endCol: number;
    endRow: number;
  } | null = null;

  /** See CanvasRenderer.rowShadow — same FNV-1a no-op-repaint skip. */
  private rowShadow: number[] = [];
  /** Set when instance slots no longer describe the buffer (atlas reset, theme). */
  private needsFullRebuild = true;

  private lastResizeCols = -1;
  private lastResizeRows = -1;
  private lastResizeCellW = -1;
  private lastResizeCellH = -1;
  private lastScrollbarOpacity = -1;

  private selectionManager?: SelectionManager;
  private hoveredHyperlinkId = 0;
  private previousHoveredHyperlinkId = 0;
  private hoveredLinkRange: { startX: number; startY: number; endX: number; endY: number } | null =
    null;
  private previousHoveredLinkRange: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null = null;

  private onContextLost = (event: Event): void => {
    // Without preventDefault the context is never restored.
    event.preventDefault();
    this.contextLost = true;
  };

  private onContextRestored = (): void => {
    this.contextLost = false;
    this.disposeGlResources();
    this.initGlResources();
    this.rowShadow.length = 0;
    this.needsFullRebuild = true;
    // Force resize() to rebuild geometry and buffer capacities.
    this.lastResizeCols = -1;
  };

  constructor(canvas: HTMLCanvasElement, options: WebglRendererOptions = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('webgl: WebGL2 is not available on this canvas');
    this.gl = gl;

    this.fontSize = options.fontSize ?? 15;
    this.fontFamily = options.fontFamily ?? 'monospace';
    this.cursorStyle = options.cursorStyle ?? 'block';
    this.cursorBlink = options.cursorBlink ?? false;
    this.theme = { ...DEFAULT_THEME, ...options.theme };
    this.devicePixelRatio =
      options.devicePixelRatio ??
      (typeof window !== 'undefined' ? window.devicePixelRatio : 1) ??
      1;
    this.metrics = measureFontMetrics(this.fontSize, this.fontFamily);
    this.parseThemeColors();

    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);

    // Assigned by initGlResources; the definite-assignment dance keeps the
    // create/destroy pair in one place for context restore.
    this.atlas = undefined as unknown as GlyphAtlas;
    this.bgRects = undefined as unknown as RectPass;
    this.decoRects = undefined as unknown as RectPass;
    this.glyphs = undefined as unknown as GlyphPass;
    this.overlayRects = undefined as unknown as RectPass;
    this.cursorGlyph = undefined as unknown as GlyphPass;
    this.images = undefined as unknown as ImagePass;
    this.initGlResources();

    if (this.cursorBlink) this.startCursorBlink();
  }

  // ==========================================================================
  // GL resource lifecycle
  // ==========================================================================

  private initGlResources(): void {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    // Shaders emit premultiplied alpha.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const rectProgram = createRectProgram(gl);
    const glyphProgram = createGlyphProgram(gl);
    this.programs = [rectProgram.program, glyphProgram.program];
    this.atlas = new GlyphAtlas(gl, this.atlasOptions());
    this.atlasGeneration = this.atlas.generation;

    const cells = Math.max(1, this.cols * this.rows);
    this.bgRects = new RectPass(gl, rectProgram, cells);
    this.decoRects = new RectPass(gl, rectProgram, cells * 2);
    this.glyphs = new GlyphPass(gl, glyphProgram, cells);
    this.overlayRects = new RectPass(gl, rectProgram, OVERLAY_RECT_COUNT);
    this.cursorGlyph = new GlyphPass(gl, glyphProgram, 1);
    this.images = new ImagePass(gl);
  }

  private disposeGlResources(): void {
    for (const program of this.programs) this.gl.deleteProgram(program);
    this.programs = [];
    this.atlas?.dispose();
    this.bgRects?.dispose();
    this.decoRects?.dispose();
    this.glyphs?.dispose();
    this.overlayRects?.dispose();
    this.cursorGlyph?.dispose();
    this.images?.dispose();
  }

  private atlasOptions() {
    return {
      fontSize: this.fontSize,
      fontFamily: this.fontFamily,
      devicePixelRatio: this.devicePixelRatio,
      cellWidth: this.metrics.width * this.devicePixelRatio,
      cellHeight: this.metrics.height * this.devicePixelRatio,
      baseline: Math.round(this.metrics.baseline * this.devicePixelRatio),
    };
  }

  // ==========================================================================
  // Geometry
  // ==========================================================================

  public resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.lastResizeCols = cols;
    this.lastResizeRows = rows;
    this.lastResizeCellW = this.metrics.width;
    this.lastResizeCellH = this.metrics.height;
    this.rowShadow.length = 0;
    this.needsFullRebuild = true;

    const cssWidth = cols * this.metrics.width;
    const cssHeight = rows * this.metrics.height;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.canvas.width = Math.max(1, Math.round(cssWidth * this.devicePixelRatio));
    this.canvas.height = Math.max(1, Math.round(cssHeight * this.devicePixelRatio));

    // Rounded boundaries: cell k spans colX[k]..colX[k+1] with no gap.
    this.colX = new Int32Array(cols + 1);
    for (let x = 0; x <= cols; x++) {
      this.colX[x] = Math.round(x * this.metrics.width * this.devicePixelRatio);
    }
    this.rowY = new Int32Array(rows + 1);
    for (let y = 0; y <= rows; y++) {
      this.rowY[y] = Math.round(y * this.metrics.height * this.devicePixelRatio);
    }
    this.cellWidthDevice = this.metrics.width * this.devicePixelRatio;
    this.cellHeightDevice = this.metrics.height * this.devicePixelRatio;

    const cells = Math.max(1, cols * rows);
    this.bgRects.resize(cells);
    this.decoRects.resize(cells * 2);
    this.glyphs.resize(cells);
    this.atlas.reconfigure(this.atlasOptions());
    this.atlasGeneration = this.atlas.generation;
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  public remeasureFont(): void {
    this.metrics = measureFontMetrics(this.fontSize, this.fontFamily);
  }

  // ==========================================================================
  // Main render
  // ==========================================================================

  public render(
    buffer: IRenderable,
    forceAll = false,
    viewportY = 0,
    scrollbackProvider?: IScrollbackProvider,
    scrollbarOpacity = 1
  ): void {
    if (this.contextLost) return;

    this.currentBuffer = buffer;
    const cursor = buffer.getCursor();
    const dims = buffer.getDimensions();
    const scrollbackLength = scrollbackProvider ? scrollbackProvider.getScrollbackLength() : 0;

    if (buffer.needsFullRedraw?.()) forceAll = true;

    // Browser zoom and cross-display window moves change devicePixelRatio at
    // runtime; a stale value renders at the wrong backing resolution.
    if (
      typeof window !== 'undefined' &&
      window.devicePixelRatio &&
      window.devicePixelRatio !== this.devicePixelRatio
    ) {
      this.devicePixelRatio = window.devicePixelRatio;
      this.lastResizeCols = -1;
    }

    const needsResize =
      this.lastResizeCols !== dims.cols ||
      this.lastResizeRows !== dims.rows ||
      this.lastResizeCellW !== this.metrics.width ||
      this.lastResizeCellH !== this.metrics.height;
    if (needsResize) {
      this.resize(dims.cols, dims.rows);
      forceAll = true;
    }

    if (viewportY !== this.lastViewportY) {
      forceAll = true;
      this.lastViewportY = viewportY;
    }
    if (this.needsFullRebuild) forceAll = true;

    const anyDirty = buffer.isDirty ? buffer.isDirty() : true;
    // While scrolled, new output migrates screen rows into scrollback, so any
    // dirt shifts every visible row.
    if (viewportY > 0 && anyDirty) forceAll = true;

    const cursorMoved =
      cursor.x !== this.lastCursorPosition.x || cursor.y !== this.lastCursorPosition.y;

    const hasSelection = this.selectionManager && this.selectionManager.hasSelection();
    this.currentSelectionCoords = hasSelection ? this.selectionManager!.getSelectionCoords() : null;

    const selectionRows = new Set<number>();
    if (this.currentSelectionCoords) {
      const coords = this.currentSelectionCoords;
      for (let row = coords.startRow; row <= coords.endRow; row++) selectionRows.add(row);
    }
    if (this.selectionManager) {
      const dirtyRows = this.selectionManager.getDirtySelectionRows();
      if (dirtyRows.size > 0) {
        for (const row of dirtyRows) selectionRows.add(row);
        this.selectionManager.clearDirtySelectionRows();
      }
    }

    const hyperlinkChanged = this.hoveredHyperlinkId !== this.previousHoveredHyperlinkId;
    const linkRangeChanged =
      JSON.stringify(this.hoveredLinkRange) !== JSON.stringify(this.previousHoveredLinkRange);

    // Idle skip: nothing changed, so no GL work at all. The previously
    // presented frame stays on screen (the compositor holds it; we never draw a
    // partial frame).
    if (
      !forceAll &&
      !anyDirty &&
      !cursorMoved &&
      !this.cursorBlink &&
      !this.placementsDirty &&
      selectionRows.size === 0 &&
      !hyperlinkChanged &&
      !linkRangeChanged &&
      scrollbarOpacity === this.lastScrollbarOpacity
    ) {
      return;
    }

    // ONE viewport fetch for the pass; getLine() re-extracts everything.
    const cells = buffer.getViewport ? buffer.getViewport() : null;
    this.currentCells = cells;
    this.currentCols = dims.cols;

    const rowAt = createViewportRowAccessor(
      buffer, cells, dims, viewportY, scrollbackLength, scrollbackProvider
    );

    const hyperlinkRows = new Set<number>();
    if (hyperlinkChanged) {
      for (let y = 0; y < dims.rows; y++) {
        const row = rowAt(y);
        if (!row) continue;
        for (let i = 0; i < row.count; i++) {
          const cell = row.src[row.base + i];
          if (
            cell &&
            (cell.hyperlink_id === this.hoveredHyperlinkId ||
              cell.hyperlink_id === this.previousHoveredHyperlinkId)
          ) {
            hyperlinkRows.add(y);
            break;
          }
        }
      }
      this.previousHoveredHyperlinkId = this.hoveredHyperlinkId;
    }
    if (linkRangeChanged) {
      if (this.previousHoveredLinkRange) {
        for (
          let y = this.previousHoveredLinkRange.startY;
          y <= this.previousHoveredLinkRange.endY;
          y++
        ) {
          hyperlinkRows.add(y);
        }
      }
      if (this.hoveredLinkRange) {
        for (let y = this.hoveredLinkRange.startY; y <= this.hoveredLinkRange.endY; y++) {
          hyperlinkRows.add(y);
        }
      }
      this.previousHoveredLinkRange = this.hoveredLinkRange;
    }

    // While scrolled the slots hold scrollback, not the live screen the shadow
    // indexes; a stale shadow would wrongly skip repaints after scrolling back.
    if (viewportY > 0) this.rowShadow.length = 0;

    for (let y = 0; y < dims.rows; y++) {
      let contentChanged = forceAll;
      if (viewportY === 0 && (forceAll || buffer.isRowDirty(y))) {
        if (cells) {
          const h = hashRow(cells, y * dims.cols, dims.cols);
          if (!forceAll) contentChanged = h !== this.rowShadow[y];
          this.rowShadow[y] = h;
        } else {
          contentChanged = true;
        }
      }

      const needsRebuild =
        viewportY > 0
          ? forceAll || selectionRows.has(y) || hyperlinkRows.has(y)
          : forceAll || contentChanged || selectionRows.has(y) || hyperlinkRows.has(y);
      if (!needsRebuild) continue;

      const row = rowAt(y);
      if (row) {
        this.buildRow(y, row.src, row.base, row.count, dims.cols);
      } else {
        this.clearRow(y, dims.cols);
      }
    }

    // A glyph miss can exhaust and reset the atlas mid-pass, invalidating every
    // quad already written. Rebuild on the next frame (the render loop is
    // per-rAF, and the flag defeats the idle skip).
    this.needsFullRebuild = this.atlas.generation !== this.atlasGeneration;
    this.atlasGeneration = this.atlas.generation;

    this.buildOverlay(cursor, viewportY, scrollbackLength, dims.rows, scrollbarOpacity);
    this.drawFrame(scrollbackLength, scrollbarOpacity);

    this.lastScrollbarOpacity = scrollbarOpacity;
    this.lastCursorPosition = { x: cursor.x, y: cursor.y };
    this.placementsDirty = false;
    buffer.clearDirty();
  }

  // ==========================================================================
  // Instance building
  // ==========================================================================

  private clearRow(y: number, cols: number): void {
    for (let x = 0; x < cols; x++) {
      const idx = y * cols + x;
      this.bgRects.clear(idx);
      this.glyphs.clear(idx);
      this.decoRects.clear(idx * 2);
      this.decoRects.clear(idx * 2 + 1);
    }
  }

  private buildRow(
    y: number,
    line: GhosttyCell[],
    base: number,
    count: number,
    cols: number
  ): void {
    const y0 = this.rowY[y];
    const y1 = this.rowY[y + 1];
    const cellHeight = y1 - y0;
    const dpr = this.devicePixelRatio;
    const underlineY = y0 + Math.round((this.metrics.baseline + 2) * dpr);
    const strikeY = y0 + Math.round(cellHeight / 2);
    const lineThickness = Math.max(1, Math.round(dpr));

    for (let x = 0; x < cols; x++) {
      const idx = y * cols + x;
      const cell = x < count ? line[base + x] : undefined;

      // Spacer cells of wide characters carry no pixels of their own; the wide
      // cell's rects already span them.
      if (!cell || cell.width === 0) {
        this.bgRects.clear(idx);
        this.glyphs.clear(idx);
        this.decoRects.clear(idx * 2);
        this.decoRects.clear(idx * 2 + 1);
        continue;
      }

      const x0 = this.colX[x];
      const span = Math.min(cols, x + Math.max(1, cell.width));
      const x1 = this.colX[span];
      const width = x1 - x0;
      const selected = this.isInSelection(x, y);
      const inverse = (cell.flags & CellFlags.INVERSE) !== 0;

      // --- background -------------------------------------------------------
      if (selected) {
        const c = this.selectionBgColor;
        this.bgRects.set(idx, x0, y0, width, cellHeight, c.r, c.g, c.b, c.a);
      } else {
        const r = inverse ? cell.fg_r : cell.bg_r;
        const g = inverse ? cell.fg_g : cell.bg_g;
        const b = inverse ? cell.fg_b : cell.bg_b;
        // (0,0,0) is "default background" in the cell encoding; leave it to the
        // clear color so themed/translucent backgrounds show through.
        if (r === 0 && g === 0 && b === 0) {
          this.bgRects.clear(idx);
        } else {
          this.bgRects.set(idx, x0, y0, width, cellHeight, r / 255, g / 255, b / 255, 1);
        }
      }

      // --- foreground color -------------------------------------------------
      let fr: number;
      let fg: number;
      let fb: number;
      if (selected) {
        fr = this.selectionFgColor.r;
        fg = this.selectionFgColor.g;
        fb = this.selectionFgColor.b;
      } else if (inverse) {
        fr = cell.bg_r / 255;
        fg = cell.bg_g / 255;
        fb = cell.bg_b / 255;
      } else {
        fr = cell.fg_r / 255;
        fg = cell.fg_g / 255;
        fb = cell.fg_b / 255;
      }
      const alpha = cell.flags & CellFlags.FAINT ? 0.5 : 1;

      // --- glyph ------------------------------------------------------------
      if (cell.flags & CellFlags.INVISIBLE) {
        this.glyphs.clear(idx);
      } else {
        const entry = this.glyphFor(cell, y, x);
        if (entry) {
          this.glyphs.set(idx, entry, x0, y0, fr, fg, fb, alpha);
        } else {
          this.glyphs.clear(idx);
        }
      }

      // --- decorations ------------------------------------------------------
      const linkHovered =
        (cell.hyperlink_id > 0 && cell.hyperlink_id === this.hoveredHyperlinkId) ||
        this.isInHoveredLinkRange(x, y);
      // Rules are opaque even in faint cells: CanvasRenderer resets globalAlpha
      // after fillText and strokes them at full alpha.
      if (cell.flags & CellFlags.UNDERLINE || linkHovered) {
        const c = linkHovered ? LINK_COLOR : null;
        this.decoRects.set(
          idx * 2,
          x0,
          underlineY,
          width,
          lineThickness,
          c ? c.r : fr,
          c ? c.g : fg,
          c ? c.b : fb,
          1
        );
      } else {
        this.decoRects.clear(idx * 2);
      }
      if (cell.flags & CellFlags.STRIKETHROUGH) {
        this.decoRects.set(idx * 2 + 1, x0, strikeY, width, lineThickness, fr, fg, fb, 1);
      } else {
        this.decoRects.clear(idx * 2 + 1);
      }
    }
  }

  /** Atlas entry for a cell, or null when it paints nothing. */
  private glyphFor(cell: GhosttyCell, y: number, x: number) {
    const chars = cell.codepoint >= 0x2580 && cell.codepoint <= 0x259f
      ? cell.grapheme_len > 0 && this.currentBuffer?.getGraphemeString
      ? this.currentBuffer.getGraphemeString(y, x) : String.fromCodePoint(cell.codepoint)
      : null;
    const rects = chars && chars.length === 1 ? blockElementRects(chars.charCodeAt(0)) : null;
    if (rects && chars) {
      const span = Math.min(this.cols, x + Math.max(1, cell.width));
      return this.atlas.getBlock(chars.charCodeAt(0), this.colX[span] - this.colX[x], this.rowY[y + 1] - this.rowY[y], rects);
    }
    let style = GlyphStyle.NONE;
    if (cell.flags & CellFlags.BOLD) style |= GlyphStyle.BOLD;
    if (cell.flags & CellFlags.ITALIC) style |= GlyphStyle.ITALIC;

    if (cell.grapheme_len > 0 && this.currentBuffer?.getGraphemeString) {
      const chars = this.currentBuffer.getGraphemeString(y, x);
      return chars ? this.atlas.get(chars, style) : null;
    }

    const codepoint = cell.codepoint;
    if (!codepoint || codepoint === 32) return null;
    if (codepoint >= 33 && codepoint <= 126) return this.atlas.getAscii(codepoint, style);
    return this.atlas.get(String.fromCodePoint(codepoint), style);
  }

  private buildOverlay(
    cursor: { x: number; y: number; visible: boolean },
    viewportY: number,
    scrollbackLength: number,
    visibleRows: number,
    scrollbarOpacity: number
  ): void {
    const showCursor = viewportY === 0 && cursor.visible && this.cursorVisible;
    this.cursorGlyph.clear(0);
    this.cursorClip = null;
    if (!showCursor || cursor.x >= this.cols || cursor.y >= this.rows) {
      this.overlayRects.clear(OVERLAY_CURSOR);
    } else {
      const x0 = this.colX[cursor.x];
      const y0 = this.rowY[cursor.y];
      const w = this.colX[cursor.x + 1] - x0;
      const h = this.rowY[cursor.y + 1] - y0;
      const c = this.cursorColor;

      if (this.cursorStyle === 'block') {
        this.overlayRects.set(OVERLAY_CURSOR, x0, y0, w, h, c.r, c.g, c.b, c.a);
        // Redraw the covered glyph in the accent color, clipped to the cell.
        const cell = this.currentCells
          ? this.currentCells[cursor.y * this.currentCols + cursor.x]
          : this.currentBuffer?.getLine(cursor.y)?.[cursor.x];
        if (cell) {
          const entry = this.glyphFor(cell, cursor.y, cursor.x);
          if (entry) {
            const accent = this.cursorAccentColor;
            this.cursorGlyph.set(0, entry, x0, y0, accent.r, accent.g, accent.b, accent.a);
            // The accent glyph may overflow the cell (combining marks, box
            // drawing); clip it so it can't paint outside the cursor block.
            this.cursorClip = { x: x0, y: y0, w, h };
          }
        }
      } else if (this.cursorStyle === 'underline') {
        const thickness =
          Math.max(2, Math.floor(this.metrics.height * 0.15)) * this.devicePixelRatio;
        this.overlayRects.set(
          OVERLAY_CURSOR,
          x0,
          y0 + h - thickness,
          w,
          thickness,
          c.r,
          c.g,
          c.b,
          c.a
        );
      } else {
        const barWidth = Math.max(2, Math.floor(this.metrics.width * 0.15)) * this.devicePixelRatio;
        this.overlayRects.set(OVERLAY_CURSOR, x0, y0, barWidth, h, c.r, c.g, c.b, c.a);
      }
    }

    if (scrollbarOpacity <= 0 || scrollbackLength === 0) {
      this.overlayRects.clear(OVERLAY_SCROLLBAR_TRACK);
      this.overlayRects.clear(OVERLAY_SCROLLBAR_THUMB);
      return;
    }

    // Same geometry as CanvasRenderer.renderScrollbar, in device pixels.
    const dpr = this.devicePixelRatio;
    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;
    const scrollbarWidth = 8 * dpr;
    const scrollbarX = canvasWidth - scrollbarWidth - 4 * dpr;
    const padding = 4 * dpr;
    const trackHeight = canvasHeight - padding * 2;
    const totalLines = scrollbackLength + visibleRows;
    const thumbHeight = Math.max(20 * dpr, (visibleRows / totalLines) * trackHeight);
    const thumbY = padding + (trackHeight - thumbHeight) * (1 - viewportY / scrollbackLength);

    this.overlayRects.set(
      OVERLAY_SCROLLBAR_TRACK,
      scrollbarX,
      padding,
      scrollbarWidth,
      trackHeight,
      0.5,
      0.5,
      0.5,
      0.1 * scrollbarOpacity
    );
    this.overlayRects.set(
      OVERLAY_SCROLLBAR_THUMB,
      scrollbarX,
      thumbY,
      scrollbarWidth,
      thumbHeight,
      0.5,
      0.5,
      0.5,
      (viewportY > 0 ? 0.5 : 0.3) * scrollbarOpacity
    );
  }

  // ==========================================================================
  // Draw
  // ==========================================================================

  private drawFrame(scrollbackLength: number, scrollbarOpacity: number): void {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    const bg = this.bgColor;
    gl.clearColor(bg.r * bg.a, bg.g * bg.a, bg.b * bg.a, bg.a);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.bgRects.draw(w, h);

    const hasImages = this.placements.length > 0;
    if (hasImages) {
      this.images.draw(
        this.placements,
        true,
        this.cellWidthDevice,
        this.cellHeightDevice,
        this.devicePixelRatio,
        w,
        h
      );
    }

    this.glyphs.draw(this.atlas, w, h);
    this.decoRects.draw(w, h);

    if (hasImages) {
      this.images.draw(
        this.placements,
        false,
        this.cellWidthDevice,
        this.cellHeightDevice,
        this.devicePixelRatio,
        w,
        h
      );
    }

    // Cursor rect, then its accent glyph clipped to the cell, then the
    // scrollbar on top of everything.
    this.overlayRects.draw(w, h, OVERLAY_CURSOR, 1);
    const clip = this.cursorClip;
    if (clip) {
      gl.enable(gl.SCISSOR_TEST);
      // GL scissor is bottom-left origin.
      gl.scissor(clip.x, h - (clip.y + clip.h), clip.w, clip.h);
      this.cursorGlyph.draw(this.atlas, w, h);
      gl.disable(gl.SCISSOR_TEST);
    }
    if (scrollbarOpacity > 0 && scrollbackLength > 0) {
      this.overlayRects.draw(w, h, OVERLAY_SCROLLBAR_TRACK, 2);
    }
  }

  // ==========================================================================
  // Images (Ghostty/Kitty graphics seam)
  // ==========================================================================

  /**
   * Replace the image placements composited with the text. Rows/cols are
   * viewport-relative; the caller owns the scrollback mapping.
   */
  public setImagePlacements(placements: ImagePlacement[]): void {
    this.placements = [...placements].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
    this.images.retainOnly(this.placements);
    this.placementsDirty = true;
  }

  public getImagePlacements(): readonly ImagePlacement[] {
    return this.placements;
  }

  // ==========================================================================
  // Public API (CanvasRenderer surface)
  // ==========================================================================

  public setTheme(theme: ITheme): void {
    this.theme = { ...DEFAULT_THEME, ...theme };
    this.parseThemeColors();
    // Default fg/bg feed painted pixels without appearing in cell data.
    this.rowShadow.length = 0;
    this.needsFullRebuild = true;
  }

  public setFontSize(size: number): void {
    this.fontSize = size;
    this.metrics = measureFontMetrics(this.fontSize, this.fontFamily);
  }

  public setFontFamily(family: string): void {
    this.fontFamily = family;
    this.metrics = measureFontMetrics(this.fontSize, this.fontFamily);
  }

  public setCursorStyle(style: 'block' | 'underline' | 'bar'): void {
    this.cursorStyle = style;
  }

  public setCursorBlink(enabled: boolean): void {
    if (enabled && !this.cursorBlink) {
      this.cursorBlink = true;
      this.startCursorBlink();
    } else if (!enabled && this.cursorBlink) {
      this.cursorBlink = false;
      this.stopCursorBlink();
    }
  }

  public resetCursorBlink(): void {
    this.stopCursorBlink();
    if (this.cursorBlink) this.startCursorBlink();
  }

  public setSelectionManager(manager: SelectionManager): void {
    this.selectionManager = manager;
  }

  public setHoveredHyperlinkId(hyperlinkId: number): void {
    this.hoveredHyperlinkId = hyperlinkId;
  }

  public setHoveredLinkRange(
    range: { startX: number; startY: number; endX: number; endY: number } | null
  ): void {
    this.hoveredLinkRange = range;
  }

  public getMetrics(): FontMetrics {
    return { ...this.metrics };
  }

  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  public get charWidth(): number {
    return this.metrics.width;
  }

  public get charHeight(): number {
    return this.metrics.height;
  }

  public clear(): void {
    this.bgRects.clearAll();
    this.decoRects.clearAll();
    this.glyphs.clearAll();
    this.overlayRects.clearAll();
    this.cursorGlyph.clearAll();
    this.rowShadow.length = 0;
    this.needsFullRebuild = true;
    if (this.contextLost) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const bg = this.bgColor;
    gl.clearColor(bg.r * bg.a, bg.g * bg.a, bg.b * bg.a, bg.a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  public dispose(): void {
    this.stopCursorBlink();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.disposeGlResources();
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private parseThemeColors(): void {
    this.bgColor = parseColor(this.theme.background, { r: 0, g: 0, b: 0, a: 1 });
    this.cursorColor = parseColor(this.theme.cursor, { r: 1, g: 1, b: 1, a: 1 });
    this.cursorAccentColor = parseColor(this.theme.cursorAccent, { r: 0, g: 0, b: 0, a: 1 });
    this.selectionBgColor = parseColor(this.theme.selectionBackground, {
      r: 1,
      g: 1,
      b: 1,
      a: 1,
    });
    this.selectionFgColor = parseColor(this.theme.selectionForeground, { r: 0, g: 0, b: 0, a: 1 });
  }

  private startCursorBlink(): void {
    this.cursorBlinkInterval = window.setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
    }, 530);
  }

  private stopCursorBlink(): void {
    if (this.cursorBlinkInterval !== undefined) {
      clearInterval(this.cursorBlinkInterval);
      this.cursorBlinkInterval = undefined;
    }
    this.cursorVisible = true;
  }

  private isInSelection(x: number, y: number): boolean {
    const sel = this.currentSelectionCoords;
    if (!sel) return false;
    const { startCol, startRow, endCol, endRow } = sel;
    if (startRow === endRow) return y === startRow && x >= startCol && x <= endCol;
    if (y === startRow) return x >= startCol;
    if (y === endRow) return x <= endCol;
    return y > startRow && y < endRow;
  }

  private isInHoveredLinkRange(x: number, y: number): boolean {
    const range = this.hoveredLinkRange;
    if (!range) return false;
    return (
      (y === range.startY && x >= range.startX && (y < range.endY || x <= range.endX)) ||
      (y > range.startY && y < range.endY) ||
      (y === range.endY && x <= range.endX && (y > range.startY || x >= range.startX))
    );
  }
}

/** FNV-1a over the cell fields that affect pixels. Mirrors CanvasRenderer. */
function hashRow(cells: GhosttyCell[], base: number, count: number): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < count; i++) {
    const c = cells[base + i];
    if (!c) continue;
    h ^= c.codepoint;
    h = Math.imul(h, 0x01000193);
    h ^= (c.fg_r << 16) | (c.fg_g << 8) | c.fg_b;
    h = Math.imul(h, 0x01000193);
    h ^= (c.bg_r << 16) | (c.bg_g << 8) | c.bg_b;
    h = Math.imul(h, 0x01000193);
    h ^= (c.flags << 24) | (c.width << 16) | c.hyperlink_id;
    h = Math.imul(h, 0x01000193);
    h ^= c.grapheme_len;
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

export type { ImagePlacement };
