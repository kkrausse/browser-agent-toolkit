import { OfficialABI, check, registerWriteCallback, type OfficialExports } from './official-abi';
import { CellFlags, DirtyState, type GhosttyCell, type GhosttyTerminalConfig,
  type RenderStateColors, type RenderStateCursor, type RGB } from './types';
import type { KeyEncoder } from './official-key';

/** Official render-state snapshots for the viewport; grid references for history. */
export class GhosttyTerminal {
  private a: OfficialABI;
  private handle = 0;
  private state = 0;
  private iterator = 0;
  private rowCells = 0;
  private scratch = 0;
  private callback?: ReturnType<typeof registerWriteCallback>;
  private responses: Uint8Array[] = [];
  private responseDecoder = new TextDecoder();
  private changed = true;
  private cells: GhosttyCell[] = [];
  private dirtyRows: boolean[] = [];
  private _cols: number;
  private _rows: number;
  private rawFields!: Record<string, (lo: number, hi: number) => number>;
  private flagFields!: [number, number][];
  private underlineOffset = 0;
  private fgOffset = 0;
  private bgOffset = 0;
  private colorValueOffset = 0;
  private palette = new Uint32Array(256);
  // Style IDs are page-local: reuse only within a single row, never globally.
  private rowStyles = new Map<number, { fg: number; bg: number; flags: number }>();
  constructor(exports: WebAssembly.Exports | OfficialExports, _memory: WebAssembly.Memory,
    cols = 80, rows = 24, config?: GhosttyTerminalConfig) {
    this.validateSize(cols, rows);
    if (config?.scrollbackLimit !== undefined && (!Number.isInteger(config.scrollbackLimit) || config.scrollbackLimit < 0 || config.scrollbackLimit > 0xffffffff)) {
      throw new RangeError('scrollbackLimit must be an unsigned 32-bit integer');
    }
    this.a = new OfficialABI(exports);
    const fields = this.a.types.GhosttyCell.bits;
    this.rawFields = {};
    for (const name of ['content_tag', 'content', 'style_id', 'wide', 'hyperlink']) {
      const { lsb, width } = fields[name];
      const mask = 2 ** width - 1;
      this.rawFields[name] = lsb >= 32 ? (_lo, hi) => (hi >>> (lsb - 32)) & mask
        : lsb + width <= 32 ? (lo, _hi) => (lo >>> lsb) & mask
        : (lo, hi) => ((lo >>> lsb) | (hi << (32 - lsb))) & mask;
    }
    this.flagFields = Object.entries({ bold: CellFlags.BOLD, italic: CellFlags.ITALIC,
      faint: CellFlags.FAINT, blink: CellFlags.BLINK, inverse: CellFlags.INVERSE,
      invisible: CellFlags.INVISIBLE, strikethrough: CellFlags.STRIKETHROUGH })
      .map(([name, flag]) => [this.a.field('GhosttyStyle', name), flag]);
    this.underlineOffset = this.a.field('GhosttyStyle', 'underline');
    this.fgOffset = this.a.field('GhosttyStyle', 'fg_color');
    this.bgOffset = this.a.field('GhosttyStyle', 'bg_color');
    this.colorValueOffset = this.a.field('GhosttyStyleColor', 'value');
    this._cols = cols; this._rows = rows;
    const a = this.a, e = a.exports;
    try {
      this.scratch = a.alloc(2048);
      this.handle = a.create('ghostty_terminal_new', cols, rows);
      this.state = a.create('ghostty_render_state_new');
      this.iterator = a.create('ghostty_render_state_row_iterator_new');
      this.rowCells = a.create('ghostty_render_state_row_cells_new');
      this.callback = registerWriteCallback(a, (_terminal, _userdata, ptr, len) => {
        this.responses.push(a.bytes.slice(ptr, ptr + len));
      });
      check(e.ghostty_terminal_set(this.handle, 1, this.callback.index));
      a.view.setUint32(this.scratch, config?.scrollbackLimit ?? 10000, true);
      check(e.ghostty_terminal_set(this.handle, 28, this.scratch));
      // Preserve the browser bridge's Unicode grapheme-clustering default,
      // including across RIS, using the official mode-default API.
      a.view.setUint16(this.scratch, 2027, true);
      a.view.setUint8(this.scratch + 2, 1);
      check(e.ghostty_terminal_set(this.handle, 33, this.scratch));
      for (const [option, color] of [[11, config?.fgColor], [12, config?.bgColor], [13, config?.cursorColor]] as const) {
        // Preserve the public bridge's historical 0 = default sentinel.
        // terminal.ts emits zero for missing theme colors.
        if (color !== undefined && color !== 0) {
          a.bytes.set([(color >>> 16) & 255, (color >>> 8) & 255, color & 255], this.scratch);
          check(e.ghostty_terminal_set(this.handle, option, this.scratch));
        }
      }
      if (config?.palette) {
        check(e.ghostty_terminal_get(this.handle, 21, this.scratch));
        for (let i = 0; i < Math.min(config.palette.length, 256); i++) {
          const color = config.palette[i];
          if (color === undefined || color === 0) continue;
          a.bytes.set([(color >>> 16) & 255, (color >>> 8) & 255, color & 255], this.scratch + i * 3);
        }
        check(e.ghostty_terminal_set(this.handle, 14, this.scratch));
      }
    } catch (error) { this.free(); throw error; }
  }
  get cols(): number { return this._cols; }
  get rows(): number { return this._rows; }
  private alive(): void { if (!this.handle) throw new Error('Terminal has been freed'); }
  private validateSize(cols: number, rows: number): void {
    if (![cols, rows].every(n => Number.isInteger(n) && n > 0 && n <= 65535)) throw new RangeError('Terminal dimensions must be integers in 1..65535');
  }
  write(data: string | Uint8Array): void {
    this.alive();
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    if (!bytes.length) return;
    this.a.with(bytes.length, ptr => {
      this.a.bytes.set(bytes, ptr);
      this.a.exports.ghostty_terminal_vt_write(this.handle, ptr, bytes.length);
    });
    this.changed = true;
    if (this.terminalNumber(33, 1)) throw new Error('Official Ghostty reported a VT processing error');
  }
  resize(cols: number, rows: number): void {
    this.alive(); this.validateSize(cols, rows);
    if (cols === this.cols && rows === this.rows) return;
    check(this.a.exports.ghostty_terminal_resize(this.handle, cols, rows, 0, 0));
    this._cols = cols; this._rows = rows; this.changed = true;
  }
  free(): void {
    const e = this.a.exports;
    if (this.handle) e.ghostty_terminal_free(this.handle);
    if (this.state) e.ghostty_render_state_free(this.state);
    if (this.iterator) e.ghostty_render_state_row_iterator_free(this.iterator);
    if (this.rowCells) e.ghostty_render_state_row_cells_free(this.rowCells);
    if (this.scratch) this.a.free(this.scratch, 2048);
    this.callback?.dispose(); this.callback = undefined;
    this.handle = this.state = this.iterator = this.rowCells = this.scratch = 0;
    this.cells = []; this.responses = [];
  }
  private number(fn: string, handle: number, key: number, size = 4): number {
    const a = this.a;
    check(a.exports[fn](handle, key, this.scratch));
    return size === 1 ? a.view.getUint8(this.scratch) : size === 2 ? a.view.getUint16(this.scratch, true) : a.view.getUint32(this.scratch, true);
  }
  private terminalNumber(key: number, size = 4): number { this.alive(); return this.number('ghostty_terminal_get', this.handle, key, size); }
  private renderNumber(key: number, size = 4): number { return this.number('ghostty_render_state_get', this.state, key, size); }
  update(): DirtyState {
    this.alive();
    if (this.changed) {
      check(this.a.exports.ghostty_render_state_update(this.state, this.handle));
      this.changed = false;
      this.snapshot();
    }
    return this.renderNumber(3) as DirtyState;
  }
  private rgb(ptr: number): RGB {
    const b = this.a.bytes; return { r: b[ptr]!, g: b[ptr + 1]!, b: b[ptr + 2]! };
  }
  getColors(): RenderStateColors {
    this.update();
    return this.colors();
  }
  private colors(): RenderStateColors {
    const e = this.a.exports, ptr = this.scratch;
    check(e.ghostty_render_state_get(this.state, 5, ptr)); const background = this.rgb(ptr);
    check(e.ghostty_render_state_get(this.state, 6, ptr)); const foreground = this.rgb(ptr);
    let cursor: RGB | null = null;
    if (this.renderNumber(8, 1)) { check(e.ghostty_render_state_get(this.state, 7, ptr)); cursor = this.rgb(ptr); }
    return { background, foreground, cursor };
  }
  getCursor(): RenderStateCursor {
    this.update();
    const hasViewport = !!this.renderNumber(14, 1);
    return {
      x: this.terminalNumber(3, 2), y: this.terminalNumber(4, 2),
      viewportX: hasViewport ? this.renderNumber(15, 2) : -1,
      viewportY: hasViewport ? this.renderNumber(16, 2) : -1,
      visible: hasViewport && !!this.renderNumber(11, 1), blinking: !!this.renderNumber(12, 1),
      style: (['bar', 'block', 'underline', 'block'] as const)[this.renderNumber(10)] ?? 'block',
    };
  }
  isRowDirty(y: number): boolean { this.update(); return this.renderNumber(3) === DirtyState.FULL || !!this.dirtyRows[y]; }
  markClean(): void { this.update(); check(this.a.exports.ghostty_render_state_clean(this.state)); this.dirtyRows.fill(false); }
  clearDirty(): void { this.markClean(); }
  isDirty(): boolean { return this.update() !== DirtyState.NONE; }
  needsFullRedraw(): boolean { return this.update() === DirtyState.FULL; }
  getViewport(): GhosttyCell[] { this.update(); return this.cells; }
  getLine(y: number): GhosttyCell[] | null {
    if (!Number.isInteger(y) || y < 0 || y >= this.rows) return null;
    return this.getViewport().slice(y * this.cols, (y + 1) * this.cols).map(c => ({ ...c }));
  }
  private styleFlags(ptr: number): number {
    const a = this.a;
    let flags = 0;
    const bytes = a.bytes;
    for (const [offset, flag] of this.flagFields) {
      if (bytes[ptr + offset]) flags |= flag;
    }
    if (a.view.getInt32(ptr + this.underlineOffset, true)) flags |= CellFlags.UNDERLINE;
    return flags;
  }
  private packed(raw: bigint, name: string): number {
    const field = this.a.types.GhosttyCell.bits[name];
    return Number((raw >> BigInt(field.lsb)) & ((1n << BigInt(field.width)) - 1n));
  }
  private baseCell(raw: bigint, foreground: RGB, background: RGB, flags: number, count: number): GhosttyCell {
    const tag = this.packed(raw, 'content_tag');
    const wide = this.packed(raw, 'wide');
    return { codepoint: tag < 2 ? this.packed(raw, 'content') & 0x1fffff : 0,
      fg_r: foreground.r, fg_g: foreground.g, fg_b: foreground.b,
      bg_r: background.r, bg_g: background.g, bg_b: background.b, flags,
      width: wide === 0 ? 1 : wide === 1 ? 2 : 0,
      hyperlink_id: this.packed(raw, 'hyperlink'), grapheme_len: Math.max(0, count - 1) };
  }
  private snapshot(): void {
    const a = this.a, e = a.exports, ptr = this.scratch;
    const dirty = this.renderNumber(3);
    if (dirty === DirtyState.NONE && this.cells.length === this.cols * this.rows) return;
    const defaults = this.colors();
    const defaultFg = (defaults.foreground.r << 16) | (defaults.foreground.g << 8) | defaults.foreground.b;
    const defaultBg = (defaults.background.r << 16) | (defaults.background.g << 8) | defaults.background.b;
    check(e.ghostty_render_state_get(this.state, 9, ptr));
    const paletteBytes = a.bytes;
    for (let i = 0; i < 256; i++) this.palette[i] = (paletteBytes[ptr + i * 3]! << 16) | (paletteBytes[ptr + i * 3 + 1]! << 8) | paletteBytes[ptr + i * 3 + 2]!;
    const color = (view: DataView, at: number, fallback: number): number => {
      const tag = view.getUint32(at, true), value = at + this.colorValueOffset;
      return tag === 1 ? this.palette[view.getUint8(value)]! : tag === 2
        ? (view.getUint8(value) << 16) | (view.getUint8(value + 1) << 8) | view.getUint8(value + 2) : fallback;
    };
    const rawTag = this.rawFields.content_tag!, rawContent = this.rawFields.content!, rawStyle = this.rawFields.style_id!;
    const rawWide = this.rawFields.wide!, rawLink = this.rawFields.hyperlink!;
    a.view.setUint32(ptr, this.iterator, true);
    check(e.ghostty_render_state_get(this.state, 4, ptr));
    let y = 0;
    while (e.ghostty_render_state_row_iterator_next(this.iterator)) {
      this.dirtyRows[y] = !!this.number('ghostty_render_state_row_get', this.iterator, 1, 1);
      if (dirty !== DirtyState.FULL && !this.dirtyRows[y] && this.cells.length === this.cols * this.rows) { y++; continue; }
      a.view.setUint32(ptr, this.rowCells, true);
      check(e.ghostty_render_state_row_get(this.iterator, 3, ptr));
      check(e.ghostty_render_state_row_get(this.iterator, 5, ptr));
      let view = a.view;
      const rawPtr = view.getUint32(ptr, true), count = view.getUint32(ptr + 4, true);
      if (count !== this.cols) throw new Error('Unexpected official bulk row width');
      this.rowStyles.clear();
      for (let x = 0; x < count; x++) {
        const lo = view.getUint32(rawPtr + x * 8, true), hi = view.getUint32(rawPtr + x * 8 + 4, true);
        const tag = rawTag(lo, hi), content = rawContent(lo, hi), styleID = rawStyle(lo, hi), wide = rawWide(lo, hi);
        let fg = defaultFg, bg = defaultBg, flags = 0, graphemeLength = 0;
        let selected = false;
        if (styleID) {
          let style = this.rowStyles.get(styleID);
          if (!style) {
            check(e.ghostty_render_state_row_cells_select(this.rowCells, x)); selected = true;
            a.sized(ptr, 'GhosttyStyle');
            check(e.ghostty_render_state_row_cells_get(this.rowCells, 2, ptr));
            view = a.view;
            style = { fg: color(view, ptr + this.fgOffset, defaultFg), bg: color(view, ptr + this.bgOffset, defaultBg), flags: this.styleFlags(ptr) };
            this.rowStyles.set(styleID, style);
          }
          fg = style.fg; bg = style.bg; flags = style.flags;
        }
        if (tag === 2) bg = this.palette[content & 255]!;
        else if (tag === 3) bg = ((content & 255) << 16) | (content & 0xff00) | (content >>> 16);
        else if (tag === 1) {
          if (!selected) check(e.ghostty_render_state_row_cells_select(this.rowCells, x));
          graphemeLength = Math.max(0, this.number('ghostty_render_state_row_cells_get', this.rowCells, 3) - 1);
          view = a.view;
        }
        const index = y * this.cols + x;
        let cell = this.cells[index];
        if (!cell) this.cells[index] = cell = { codepoint: 0, fg_r: 0, fg_g: 0, fg_b: 0, bg_r: 0, bg_g: 0, bg_b: 0, flags: 0, width: 1, hyperlink_id: 0, grapheme_len: 0 };
        cell.codepoint = tag < 2 ? content & 0x1fffff : 0;
        cell.fg_r = fg >>> 16; cell.fg_g = (fg >>> 8) & 255; cell.fg_b = fg & 255;
        cell.bg_r = bg >>> 16; cell.bg_g = (bg >>> 8) & 255; cell.bg_b = bg & 255;
        cell.flags = flags; cell.width = wide === 0 ? 1 : wide === 1 ? 2 : 0;
        cell.hyperlink_id = rawLink(lo, hi); cell.grapheme_len = graphemeLength;
      }
      y++;
    }
    this.cells.length = this.cols * this.rows;
    this.dirtyRows.length = this.rows;
  }
  isAlternateScreen(): boolean { return this.terminalNumber(6) !== 0; }
  hasBracketedPaste(): boolean { return this.getMode(2004); }
  hasFocusEvents(): boolean { return this.getMode(1004); }
  // MOUSE_TRACKING writes a one-byte bool; a wider read picks up stale scratch bytes.
  hasMouseTracking(): boolean { return this.terminalNumber(11, 1) !== 0; }
  getMode(mode: number, isAnsi = false): boolean {
    this.alive();
    if (!Number.isInteger(mode) || mode < 0 || mode > 32767) throw new RangeError('Invalid mode number');
    this.a.view.setUint16(this.scratch, mode | (isAnsi ? 0x8000 : 0), true);
    const result = this.a.exports.ghostty_terminal_get(this.handle, 37, this.scratch);
    // Unknown modes have no state in Ghostty and are reported as unset.
    if (result === -2) return false;
    check(result); return !!this.a.view.getUint8(this.scratch + 2);
  }
  getDimensions(): { cols: number; rows: number } { return { cols: this.cols, rows: this.rows }; }
  getScrollbackLength(): number { return this.terminalNumber(15); }
  syncKeyEncoder(encoder: KeyEncoder): void { this.alive(); encoder.syncFromTerminal(this.handle); }
  hasResponse(): boolean { this.alive(); return this.responses.length > 0; }
  readResponse(): string | null {
    if (!this.hasResponse()) return null;
    const response = this.responses.map(bytes => this.responseDecoder.decode(bytes, { stream: true })).join('');
    this.responses = []; return response;
  }
  private grid<T>(row: number, col: number, history: boolean, fn: (ref: number) => T): T | null {
    this.alive();
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || col >= this.cols ||
      row >= (history ? this.getScrollbackLength() : this.rows)) return null;
    const a = this.a;
    const pointSize = a.types.GhosttyPoint.size;
    return a.with(pointSize + a.types.GhosttyGridRef.size, ptr => {
      a.view.setUint32(ptr, history ? 3 : 0, true);
      a.view.setUint16(ptr + a.field('GhosttyPoint', 'value'), col, true);
      a.view.setUint32(ptr + a.field('GhosttyPoint', 'value') + a.field('GhosttyPointCoordinate', 'y'), row, true);
      const ref = ptr + pointSize;
      a.sized(ref, 'GhosttyGridRef');
      check(a.exports.ghostty_terminal_grid_ref(this.handle, ptr, ref));
      return fn(ref);
    });
  }
  private variable(ref: number, name: string, unit: number): Uint8Array {
    const a = this.a, fn = a.exports[name];
    return a.with(4, len => {
      const result = fn(ref, 0, 0, len);
      if (result !== 0 && result !== -3) check(result);
      const count = a.view.getUint32(len, true);
      if (!count) return new Uint8Array();
      return a.with(count * unit, ptr => {
        check(fn(ref, ptr, count, len));
        return a.bytes.slice(ptr, ptr + a.view.getUint32(len, true) * unit);
      });
    });
  }
  private grapheme(row: number, col: number, history: boolean): number[] | null {
    return this.grid(row, col, history, ref => {
      const bytes = this.variable(ref, 'ghostty_grid_ref_graphemes', 4);
      return Array.from(new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
    });
  }
  getGrapheme(row: number, col: number): number[] | null { return this.grapheme(row, col, false); }
  getScrollbackGrapheme(row: number, col: number): number[] | null { return this.grapheme(row, col, true); }
  getGraphemeString(row: number, col: number): string { const g = this.getGrapheme(row, col); return g?.length ? g.map(c => String.fromCodePoint(c)).join('') : ' '; }
  getScrollbackGraphemeString(row: number, col: number): string { const g = this.getScrollbackGrapheme(row, col); return g?.length ? g.map(c => String.fromCodePoint(c)).join('') : ' '; }
  getHyperlinkUri(row: number, col: number): string | null {
    return this.grid(row, col, false, ref => new TextDecoder().decode(this.variable(ref, 'ghostty_grid_ref_hyperlink_uri', 1))) || null;
  }
  getScrollbackHyperlinkUri(row: number, col: number): string | null {
    return this.grid(row, col, true, ref => new TextDecoder().decode(this.variable(ref, 'ghostty_grid_ref_hyperlink_uri', 1))) || null;
  }
  isRowWrapped(row: number): boolean {
    return this.grid(row, 0, false, ref => {
      check(this.a.exports.ghostty_grid_ref_row(ref, this.scratch));
      const raw = this.a.view.getBigUint64(this.scratch, true);
      // IBufferLine.isWrapped means continuation FROM the previous row.
      check(this.a.exports.ghostty_row_get(raw, 2, this.scratch));
      return !!this.a.view.getUint8(this.scratch);
    }) ?? false;
  }
  getScrollbackLine(row: number): GhosttyCell[] | null {
    if (!Number.isInteger(row) || row < 0 || row >= this.getScrollbackLength()) return null;
    this.update();
    const defaults = this.colors(), a = this.a, e = a.exports;
    check(e.ghostty_render_state_get(this.state, 9, this.scratch));
    const palette = a.bytes.slice(this.scratch, this.scratch + 768);
    const resolve = (ptr: number, fallback: RGB): RGB => {
      const tag = a.view.getUint32(ptr, true), value = ptr + a.field('GhosttyStyleColor', 'value');
      if (tag === 2) return this.rgb(value);
      if (tag === 1) { const i = a.bytes[value]! * 3; return { r: palette[i]!, g: palette[i + 1]!, b: palette[i + 2]! }; }
      return fallback;
    };
    const result: GhosttyCell[] = [];
    for (let col = 0; col < this.cols; col++) {
      result.push(this.grid(row, col, true, ref => {
        const ptr = this.scratch;
        check(e.ghostty_grid_ref_cell(ref, ptr)); const raw = a.view.getBigUint64(ptr, true);
        a.sized(ptr, 'GhosttyStyle'); check(e.ghostty_grid_ref_style(ref, ptr));
        const flags = this.styleFlags(ptr);
        const fg = resolve(ptr + a.field('GhosttyStyle', 'fg_color'), defaults.foreground);
        let bg = resolve(ptr + a.field('GhosttyStyle', 'bg_color'), defaults.background);
        const tag = this.packed(raw, 'content_tag'), content = this.packed(raw, 'content');
        if (tag === 2) { const i = (content & 255) * 3; bg = { r: palette[i]!, g: palette[i + 1]!, b: palette[i + 2]! }; }
        if (tag === 3) bg = { r: content & 255, g: (content >>> 8) & 255, b: (content >>> 16) & 255 };
        const count = this.variable(ref, 'ghostty_grid_ref_graphemes', 4).length / 4;
        return this.baseCell(raw, fg, bg, flags, count);
      })!);
    }
    return result;
  }
}
