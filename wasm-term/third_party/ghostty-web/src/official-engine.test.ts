import { beforeAll, expect, test } from 'bun:test';
import { Ghostty, CellFlags, DirtyState } from './ghostty';
import { Key, KeyAction, KeyEncoderOption, KittyKeyFlags, Mods } from './types';
import { OfficialABI, check } from './official-abi';
let ghostty: Ghostty;
beforeAll(async () => { ghostty = await Ghostty.load(); });
const text = (cells: { codepoint: number }[] | null) => cells?.map(c => String.fromCodePoint(c.codepoint || 32)).join('').trimEnd();

test('official release artifact identity and native ABI', async () => {
  const bytes = await Bun.file(new URL('../vendor/ghostty-vt.wasm', import.meta.url)).arrayBuffer();
  expect(bytes.byteLength).toBe(1006746);
  expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe('f7977b04bfa934fe4049bf1c49aca8724f6a880da19d61466b8935ebafc8846c');
  const module = await WebAssembly.compile(bytes);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const names = WebAssembly.Module.exports(module).map(e => e.name);
  expect(names).toContain('ghostty_terminal_vt_write');
  expect(names).not.toContain('ghostty_terminal_new_with_config');
});

test('SGR truecolor/palette/default colors and every legacy style flag', () => {
  const t = ghostty.createTerminal(20, 3, { fgColor: 0x123456, bgColor: 0x654321, cursorColor: 0x010203, palette: [0, 0x112233] });
  try {
    t.write('\x1b[1;2;3;4;5;7;8;9;38;2;10;20;30;48;2;40;50;60mX\x1b[0mY\x1b[31mZ');
    const [x, y, z] = t.getLine(0)!;
    expect(x).toMatchObject({ codepoint: 88, fg_r: 10, fg_g: 20, fg_b: 30, bg_r: 40, bg_g: 50, bg_b: 60, flags: 255 });
    expect(y).toMatchObject({ fg_r: 0x12, fg_g: 0x34, fg_b: 0x56, bg_r: 0x65, flags: 0 });
    expect(z).toMatchObject({ fg_r: 0x11, fg_g: 0x22, fg_b: 0x33 });
    expect(t.getColors().cursor).toEqual({ r: 1, g: 2, b: 3 });
    t.write('\x1b]10;rgb:aa/bb/cc\x07');
    expect(t.getColors().foreground).toEqual({ r: 170, g: 187, b: 204 });
  } finally { t.free(); }
});

test('UTF-8 split writes, combining clusters, ZWJ emoji and wide-cell tails', () => {
  const t = ghostty.createTerminal(30, 3);
  try {
    const bytes = new TextEncoder().encode('A界e\u0301👩‍💻');
    for (const byte of bytes) t.write(Uint8Array.of(byte));
    const cells = t.getLine(0)!;
    expect(cells[1]).toMatchObject({ codepoint: 0x754c, width: 2 });
    expect(cells[2]!.width).toBe(0);
    expect(t.getGraphemeString(0, 3)).toBe('e\u0301');
    expect(cells[3]!.grapheme_len).toBe(1);
    expect(t.getGraphemeString(0, 4)).toBe('👩‍💻');
    expect(cells[4]!.width).toBe(2);
    const long = 'a' + '\u0301'.repeat(40);
    t.write('\r\n' + long);
    expect(t.getGraphemeString(1, 0)).toBe(long);
  } finally { t.free(); }
});

test('history retains styled graphemes and hyperlinks; bounded history and alt screen', () => {
  const t = ghostty.createTerminal(10, 2, { scrollbackLimit: 3 });
  try {
    t.write('\x1b[1;38;2;1;2;3m\x1b]8;;https://example.com\x1b\\e\u0301界\x1b]8;;\x1b\\\x1b[0m\r\nsecond\r\nthird');
    expect(t.getScrollbackLength()).toBe(1);
    expect(t.getScrollbackLine(0)![0]).toMatchObject({ codepoint: 101, flags: CellFlags.BOLD, fg_r: 1, fg_g: 2, fg_b: 3, grapheme_len: 1, hyperlink_id: 1 });
    expect(t.getScrollbackGraphemeString(0, 0)).toBe('e\u0301');
    expect(t.getScrollbackHyperlinkUri(0, 1)).toBe('https://example.com');
    expect(t.getScrollbackLine(0)![1]!.width).toBe(2);
    expect(t.getScrollbackLine(-1)).toBeNull();
    t.write('\x1b[?1049h\x1b[HALT');
    expect(t.isAlternateScreen()).toBe(true);
    expect(t.getScrollbackLength()).toBe(0);
    expect(text(t.getLine(0))).toBe('ALT');
    t.write('\x1b[?1049l');
    expect(t.isAlternateScreen()).toBe(false);
    expect(t.getScrollbackLength()).toBe(1);
    expect(text(t.getLine(0))).toBe('second');
    t.write('\r\nx'.repeat(5000));
    // Official pruning is at page granularity (documented in terminal.h).
    expect(t.getScrollbackLength()).toBeLessThan(1000);
  } finally { t.free(); }
});

test('resize reflows, soft wrap, dirty state and cursor shape/modes', () => {
  const t = ghostty.createTerminal(6, 3);
  try {
    t.write('abcdefgh');
    expect(t.isRowWrapped(0)).toBe(false);
    expect(t.isRowWrapped(1)).toBe(true);
    expect(t.getCursor()).toMatchObject({ x: 2, y: 1 });
    expect(t.update()).toBe(DirtyState.FULL);
    t.markClean(); expect(t.update()).toBe(DirtyState.NONE);
    t.write('\x1b[5 q\x1b[?2004h\x1b[?1004h\x1b[?1000h');
    expect(t.getCursor()).toMatchObject({ blinking: true, style: 'bar' });
    expect(t.hasBracketedPaste()).toBe(true); expect(t.hasFocusEvents()).toBe(true); expect(t.hasMouseTracking()).toBe(true);
    t.write('\x1b[?25l'); expect(t.getCursor().visible).toBe(false);
    t.resize(10, 3);
    expect(text(t.getLine(0))).toBe('abcdefgh');
    expect(t.getViewport()).toHaveLength(30);
    t.resize(4, 2); expect(t.getViewport()).toHaveLength(8);
    expect(() => t.resize(0, 2)).toThrow(RangeError);
  } finally { t.free(); }
});

test('official PTY callbacks return DA/DSR/DECRQM/OSC replies without truncation', () => {
  const t = ghostty.createTerminal(80, 24, { fgColor: 0x123456 });
  try {
    t.write('\x1b[4;7H\x1b[6n\x1b[5n\x1b[c\x1b[>c\x1b[?2004h\x1b[?2004$p\x1b]10;?\x07');
    const reply = t.readResponse()!;
    expect(reply).toContain('\x1b[4;7R'); expect(reply).toContain('\x1b[0n');
    expect(reply).toContain('\x1b[?62;22c'); expect(reply).toContain('\x1b[>1;0;0c');
    expect(reply).toContain('\x1b[?2004;1$y'); expect(reply).toContain('rgb:1212/3434/5656');
    expect(t.hasResponse()).toBe(false); expect(t.readResponse()).toBeNull();
    t.write('\x1b[6n'.repeat(200));
    expect(t.readResponse()).toBe('\x1b[4;7R'.repeat(200));
  } finally { t.free(); }
});

test('official encoder handles modifiers, application arrows, large UTF-8 and Kitty', () => {
  const t = ghostty.createTerminal(), k = ghostty.createKeyEncoder();
  const decode = (event: Parameters<typeof k.encode>[0]) => new TextDecoder().decode(k.encode(event));
  try {
    expect(decode({ action: KeyAction.PRESS, key: Key.UP, mods: 0 })).toBe('\x1b[A');
    k.setOption(KeyEncoderOption.CURSOR_KEY_APPLICATION, true);
    expect(decode({ action: KeyAction.PRESS, key: Key.UP, mods: 0 })).toBe('\x1bOA');
    const utf8 = '界'.repeat(100);
    expect(decode({ action: KeyAction.PRESS, key: Key.UNIDENTIFIED, mods: 0, utf8 })).toBe(utf8);
    expect(decode({ action: KeyAction.PRESS, key: Key.C, mods: Mods.CTRL, utf8: 'c', unshiftedCodepoint: 99 })).toBe('\x03');
    t.write('\x1b[>1u'); k.setTerminal(t);
    expect(decode({ action: KeyAction.PRESS, key: Key.ESCAPE, mods: 0 })).toBe('\x1b[27u');
    k.setKittyFlags(KittyKeyFlags.ALL);
    expect(decode({ action: KeyAction.PRESS, key: Key.PRINT_SCREEN, mods: 0 })).toBe('\x1b[57361u');
    k.setKittyFlags(KittyKeyFlags.DISAMBIGUATE);
  } finally { t.free(); k.dispose(); }
  expect(() => k.encode({ action: KeyAction.PRESS, key: Key.ENTER, mods: 0 })).toThrow('disposed');
});

test('native color defaults survive sparse config, erased backgrounds and resets', () => {
  const t = ghostty.createTerminal(10, 2, { palette: [0, undefined, 0x010203] });
  try {
    t.write('\x1b[31mR\x1b[32mG\x1b[44m\x1b[K');
    expect(t.getLine(0)![0]!.fg_r).toBeGreaterThan(0);
    expect(t.getLine(0)![1]).toMatchObject({ fg_r: 1, fg_g: 2, fg_b: 3 });
    expect(t.getLine(0)![2]!.bg_b).toBeGreaterThan(0);
    t.write('\r\nnext\r\nlast');
    expect(t.getScrollbackLine(0)![2]!.bg_b).toBeGreaterThan(0);
    t.write('\x1b[?2027l'); expect(t.getMode(2027)).toBe(false);
    t.write('\x1bc'); expect(t.getMode(2027)).toBe(true);
  } finally { t.free(); }
});

test('OSC 8 adjacent URI identity, long links and graphemes survive history', () => {
  const t = ghostty.createTerminal(20, 2);
  try {
    const uri = 'https://example.com/' + 'x'.repeat(1900);
    t.write(`\x1b]8;;${uri}\x1b\\A\x1b]8;;https://other.example\x1b\\B\x1b]8;;\x1b\\C`);
    expect(t.getHyperlinkUri(0, 0)).toBe(uri);
    expect(t.getHyperlinkUri(0, 1)).toBe('https://other.example');
    expect(t.getHyperlinkUri(0, 2)).toBeNull();
    t.write('\r\nsecond\r\nthird');
    expect(t.getScrollbackHyperlinkUri(0, 0)).toBe(uri);
  } finally { t.free(); }
});

test('memory growth, independent response hooks, disposal and recreation', () => {
  const a = ghostty.createTerminal(80, 24), b = ghostty.createTerminal(20, 3);
  try {
    a.write('x'.repeat(400000));
    expect(a.getLine(23)![0]!.codepoint).toBe(120);
    b.write('B\x1b[6n'); expect(b.readResponse()).toBe('\x1b[1;2R');
    expect(a.readResponse()).toBeNull();
    a.free(); a.free(); expect(() => a.write('x')).toThrow('freed');
    const c = ghostty.createTerminal();
    try { c.write('\x1b[5n'); expect(c.readResponse()).toBe('\x1b[0n'); } finally { c.free(); }
  } finally { a.free(); b.free(); }
});

test('bulk rows agree with native per-cell getters across pages, style reuse and palette changes', () => {
  const t = ghostty.createTerminal(120, 40);
  try {
    // Produce many differently styled pages, then compare the active snapshot.
    for (let y = 0; y < 180; y++) {
      t.write(`\x1b[38;2;${y};${255 - y};77;48;5;${16 + y}m` + 'a界e\u0301'.repeat(20) + '\r\n');
    }
    for (const mutation of ['', '\x1b]4;180;rgb:ab/cd/ef\x07\x1b[H\x1b[48;2;7;8;9m\x1b[K', '\x1b[?1049h\x1b[H\x1b[32;44mALT']) {
      t.write(mutation);
      const cells = t.getViewport();
      const defaults = t.getColors();
      const native = t as unknown as { a: OfficialABI; state: number; iterator: number; rowCells: number; scratch: number };
      const { a, state, iterator, rowCells, scratch: ptr } = native, e = a.exports;
      a.view.setUint32(ptr, iterator, true); check(e.ghostty_render_state_get(state, 4, ptr));
      let index = 0;
      while (e.ghostty_render_state_row_iterator_next(iterator)) {
        a.view.setUint32(ptr, rowCells, true); check(e.ghostty_render_state_row_get(iterator, 3, ptr));
        while (e.ghostty_render_state_row_cells_next(rowCells)) {
          const cell = cells[index++]!;
          check(e.ghostty_render_state_row_cells_get(rowCells, 1, ptr));
          const raw = a.view.getBigUint64(ptr, true);
          check(e.ghostty_cell_get(raw, 1, ptr)); expect(cell.codepoint).toBe(a.view.getUint32(ptr, true));
          check(e.ghostty_cell_get(raw, 3, ptr)); const wide = a.view.getUint32(ptr, true);
          expect(cell.width).toBe(wide === 0 ? 1 : wide === 1 ? 2 : 0);
          check(e.ghostty_render_state_row_cells_get(rowCells, 3, ptr));
          expect(cell.grapheme_len).toBe(Math.max(0, a.view.getUint32(ptr, true) - 1));
          for (const [key, fallback, actual] of [[6, defaults.foreground, [cell.fg_r, cell.fg_g, cell.fg_b]], [5, defaults.background, [cell.bg_r, cell.bg_g, cell.bg_b]]] as const) {
            const result = e.ghostty_render_state_row_cells_get(rowCells, key, ptr);
            if (result !== -2) check(result);
            const expected = result === 0 ? Array.from(a.bytes.subarray(ptr, ptr + 3)) : [fallback.r, fallback.g, fallback.b];
            expect(Array.from(actual)).toEqual(expected);
          }
        }
      }
      expect(index).toBe(4800);
      t.markClean();
    }
  } finally { t.free(); }
});

// hasMouseTracking read a one-byte bool as four bytes, so leftover scratch
// bytes made it report tracking that the program had turned off (or never on).
test('mouse tracking reads false before it is enabled and after it is disabled', () => {
  const t = ghostty.createTerminal(20, 3);
  try {
    expect(t.hasMouseTracking()).toBe(false);
    t.write('\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h');
    expect(t.hasMouseTracking()).toBe(true);
    t.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l');
    expect(t.hasMouseTracking()).toBe(false);
    // Unrelated reads leave wide values in the shared scratch buffer.
    t.getScrollbackLength(); t.getColors();
    expect(t.hasMouseTracking()).toBe(false);
    for (const mode of [9, 1000, 1002, 1003]) {
      t.write(`\x1b[?${mode}h`);
      expect(t.hasMouseTracking()).toBe(true);
      t.write(`\x1b[?${mode}l`);
      expect(t.hasMouseTracking()).toBe(false);
    }
  } finally { t.free(); }
});
