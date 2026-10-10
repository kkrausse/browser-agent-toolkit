/**
 * Glyph texture atlas.
 *
 * Glyphs are rasterized once by Canvas2D and cached in a TEXTURE_2D_ARRAY;
 * drawing a cell is then a textured quad. Cache key is (grapheme, bold, italic)
 * WITHOUT color: monochrome glyphs are stored as a coverage mask and tinted in
 * the fragment shader, so truecolor output can't explode the atlas (the trap
 * xterm.js's color-baked atlas has to LRU-evict around).
 *
 * Color glyphs (emoji) can't be tinted, so they're stored as RGBA and flagged
 * `colored`; the shader passes those through.
 *
 * Adapted in design from xterm.js's @xterm/addon-webgl TextureAtlas (MIT).
 */

/** Shelf-packed rectangle plus the placement offsets for one glyph. */
export interface GlyphEntry {
  layer: number;
  /** Normalized texcoords of the packed rect. */
  u: number;
  v: number;
  uw: number;
  vh: number;
  /** Quad size in device pixels. */
  w: number;
  h: number;
  /** Quad origin relative to the cell's top-left, in device pixels. */
  offX: number;
  offY: number;
  /** True for bitmap/color glyphs (emoji): sample RGBA instead of tinting. */
  colored: boolean;
}

export interface GlyphAtlasOptions {
  fontSize: number;
  fontFamily: string;
  devicePixelRatio: number;
  /** Cell box in device pixels; sets the rasterization scale and scratch size. */
  cellWidth: number;
  cellHeight: number;
  /** Baseline offset from the cell top, in device pixels. */
  baseline: number;
}

/** Bold/italic combination, packed into the cache key. */
export enum GlyphStyle {
  NONE = 0,
  BOLD = 1,
  ITALIC = 2,
}

const PAGE_SIZE = 1024;
const MAX_LAYERS = 4;
/** Slack around the measured ink box; antialiasing bleeds past the metrics. */
const INK_SLACK = 1;
/** Below this codepoint, assume no font ships a color glyph — skips the scan. */
const COLOR_SCAN_THRESHOLD = 0xa9;

export class GlyphAtlas {
  private gl: WebGL2RenderingContext;
  private options: GlyphAtlasOptions;
  private texture: WebGLTexture;
  private pageSize: number;

  private scratch: HTMLCanvasElement;
  private scratchCtx: CanvasRenderingContext2D;

  private cache = new Map<string, GlyphEntry | null>();
  /** (codepoint - 32) * 4 + style, for the ASCII fast path. */
  private asciiCache: (GlyphEntry | null | undefined)[] = [];

  private shelfX = 0;
  private shelfY = 0;
  private shelfHeight = 0;
  private layer = 0;

  /**
   * Bumped whenever cached entries stop being valid (exhaustion, font change,
   * context restore). Callers that memoize quads compare it and rebuild.
   */
  public generation = 0;

  constructor(gl: WebGL2RenderingContext, options: GlyphAtlasOptions) {
    this.gl = gl;
    this.options = options;
    this.pageSize = Math.min(PAGE_SIZE, gl.getParameter(gl.MAX_TEXTURE_SIZE));

    const texture = gl.createTexture();
    if (!texture) throw new Error('webgl: createTexture failed (glyph atlas)');
    this.texture = texture;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texStorage3D(
      gl.TEXTURE_2D_ARRAY,
      1,
      gl.RGBA8,
      this.pageSize,
      this.pageSize,
      Math.min(MAX_LAYERS, gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS))
    );
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.scratch = document.createElement('canvas');
    const ctx = this.scratch.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('webgl: no 2d context for glyph rasterization');
    this.scratchCtx = ctx;
    this.sizeScratch();
  }

  /** Font size/family, DPR or cell box changed: everything must re-rasterize. */
  public reconfigure(options: GlyphAtlasOptions): void {
    this.options = options;
    this.sizeScratch();
    this.reset();
  }

  /** Drop all entries and rewind the shelf allocator. */
  public reset(): void {
    this.cache.clear();
    this.asciiCache.length = 0;
    this.shelfX = 0;
    this.shelfY = 0;
    this.shelfHeight = 0;
    this.layer = 0;
    this.generation++;
  }

  public bind(unit: number): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D_ARRAY, this.texture);
  }

  public dispose(): void {
    this.gl.deleteTexture(this.texture);
  }

  /**
   * Entry for an ASCII codepoint. Avoids building a key string per cell, which
   * is the difference between zero and ~13k short-lived strings per repaint.
   */
  public getAscii(codepoint: number, style: GlyphStyle): GlyphEntry | null {
    const slot = (codepoint - 32) * 4 + style;
    const hit = this.asciiCache[slot];
    if (hit !== undefined) return hit;
    const entry = this.rasterize(String.fromCharCode(codepoint), style, false);
    this.asciiCache[slot] = entry;
    return entry;
  }

  /** Entry for an arbitrary grapheme cluster. */
  public get(chars: string, style: GlyphStyle): GlyphEntry | null {
    const key = `${style}${chars}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const entry = this.rasterize(chars, style, true);
    this.cache.set(key, entry);
    return entry;
  }

  /** Exact cell masks; actual cell sizes can vary at fractional DPR. */
  public getBlock(codepoint: number, width: number, height: number, rects: readonly (readonly number[])[]): GlyphEntry | null {
    const key = `block:${codepoint}:${width}:${height}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    if (width <= 0 || height <= 0 || width > this.scratch.width || height > this.scratch.height) return null;
    const ctx = this.scratchCtx;
    ctx.clearRect(0, 0, this.scratch.width, this.scratch.height);
    ctx.fillStyle = '#ffffff';
    for (const [left, top, right, bottom] of rects) {
      const x = Math.round(left * width / 8);
      const y = Math.round(top * height / 8);
      ctx.fillRect(x, y, Math.round(right * width / 8) - x, Math.round(bottom * height / 8) - y);
    }
    const rect = this.allocate(width, height);
    if (!rect) return null;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, rect.x, rect.y, rect.layer, width, height, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.scratch);
    const entry: GlyphEntry = {
      layer: rect.layer, u: rect.x / this.pageSize, v: rect.y / this.pageSize,
      uw: width / this.pageSize, vh: height / this.pageSize,
      w: width, h: height, offX: 0, offY: 0, colored: false,
    };
    this.cache.set(key, entry);
    return entry;
  }

  private sizeScratch(): void {
    // Room for a double-width glyph plus overflow in every direction; combining
    // marks and box-drawing glyphs routinely paint outside the cell box.
    const { cellWidth, cellHeight } = this.options;
    this.scratch.width = Math.ceil(cellWidth * 4 + 8);
    this.scratch.height = Math.ceil(cellHeight * 3 + 8);
  }

  /**
   * Draw one glyph with its ink box at the scratch origin, pack it, upload it.
   * Returns null when the glyph paints nothing (space, unsupported codepoint).
   */
  private rasterize(chars: string, style: GlyphStyle, maybeColor: boolean): GlyphEntry | null {
    const gl = this.gl;
    const ctx = this.scratchCtx;
    const { fontSize, fontFamily, devicePixelRatio, baseline } = this.options;

    let fontStyle = '';
    if (style & GlyphStyle.ITALIC) fontStyle += 'italic ';
    if (style & GlyphStyle.BOLD) fontStyle += 'bold ';
    ctx.font = `${fontStyle}${fontSize * devicePixelRatio}px ${fontFamily}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    const m = ctx.measureText(chars);
    // actualBoundingBox* are distances from the drawing origin: Left/Ascent grow
    // leftward/upward, so a left-extending combining mark has Left > 0.
    const inkLeft = m.actualBoundingBoxLeft ?? 0;
    const inkRight = m.actualBoundingBoxRight ?? m.width;
    const inkAscent = m.actualBoundingBoxAscent ?? fontSize * devicePixelRatio;
    const inkDescent = m.actualBoundingBoxDescent ?? 0;

    const w = Math.ceil(inkLeft + inkRight) + INK_SLACK * 2;
    const h = Math.ceil(inkAscent + inkDescent) + INK_SLACK * 2;
    if (w <= INK_SLACK * 2 || h <= INK_SLACK * 2) return null;
    if (w > this.scratch.width || h > this.scratch.height) return null;

    // Origin placed so the ink box lands at (0,0): texSubImage3D can only take
    // the source's top-left rect.
    const originX = Math.ceil(inkLeft) + INK_SLACK;
    const originY = Math.ceil(inkAscent) + INK_SLACK;

    ctx.clearRect(0, 0, this.scratch.width, this.scratch.height);
    // White ink: monochrome glyphs become a coverage mask the shader tints.
    ctx.fillStyle = '#ffffff';
    ctx.fillText(chars, originX, originY);

    const colored = maybeColor && this.hasColor(chars, w, h);
    const rect = this.allocate(w, h);
    if (!rect) return null;

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      rect.x,
      rect.y,
      rect.layer,
      w,
      h,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.scratch
    );

    return {
      layer: rect.layer,
      u: rect.x / this.pageSize,
      v: rect.y / this.pageSize,
      uw: w / this.pageSize,
      vh: h / this.pageSize,
      w,
      h,
      offX: -originX,
      offY: baseline - originY,
      colored,
    };
  }

  /** True when any painted pixel is non-gray, i.e. the font gave us a bitmap. */
  private hasColor(chars: string, w: number, h: number): boolean {
    let scan = false;
    for (const ch of chars) {
      const codepoint = ch.codePointAt(0) ?? 0;
      // Terminal drawing glyphs use the cell foreground even when a macOS
      // fallback font exposes them through a color-capable font.
      const terminalDrawingGlyph = codepoint >= 0x2500 && codepoint <= 0x259f;
      if (codepoint >= COLOR_SCAN_THRESHOLD && !terminalDrawingGlyph) {
        scan = true;
        break;
      }
    }
    if (!scan) return false;

    const data = this.scratchCtx.getImageData(0, 0, w, h).data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      if (data[i] !== data[i + 1] || data[i + 1] !== data[i + 2]) return true;
    }
    return false;
  }

  /**
   * Shelf allocator. Exhaustion resets the atlas — with color out of the key
   * the working set is a few hundred glyphs, so this is a safety valve, not a
   * steady state. Callers watch `generation` and rebuild.
   */
  private allocate(w: number, h: number): { x: number; y: number; layer: number } | null {
    if (w > this.pageSize || h > this.pageSize) return null;

    if (this.shelfX + w > this.pageSize) {
      this.shelfX = 0;
      this.shelfY += this.shelfHeight;
      this.shelfHeight = 0;
    }
    if (this.shelfY + h > this.pageSize) {
      this.layer++;
      this.shelfX = 0;
      this.shelfY = 0;
      this.shelfHeight = 0;
    }
    if (this.layer >= MAX_LAYERS) {
      this.reset();
      // reset() cleared the caller's pending cache entry too; it re-inserts on
      // return, and `generation` tells the renderer to rebuild every row.
    }

    const rect = { x: this.shelfX, y: this.shelfY, layer: this.layer };
    this.shelfX += w;
    if (h > this.shelfHeight) this.shelfHeight = h;
    return rect;
  }
}
