import { afterEach, describe, expect, test } from 'bun:test';
import { ImeOverlay } from './ime';
import { InputHandler } from './input-handler';
import type { Ghostty } from './ghostty';
import { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function setup() {
  const parent = document.createElement('div');
  const textarea = document.createElement('textarea');
  parent.append(textarea);
  document.body.append(parent);
  const position = {
    left: 80, top: 120, width: 8, height: 20, fontFamily: 'monospace', fontSize: 16,
    foreground: '#ffffff', background: '#000000', visible: true,
  };
  const ime = new ImeOverlay(textarea, () => ime.position(position));
  ime.position(position);
  const overlay = parent.querySelector('span')!;
  const data: string[] = [];
  const ghostty = { createKeyEncoder: () => ({ dispose() {} }) } as unknown as Ghostty;
  const input = new InputHandler(ghostty, parent, text => data.push(text), () => {},
    undefined, undefined, undefined, undefined, textarea);
  cleanups.push(() => { input.dispose(); ime.dispose(); parent.remove(); });
  const compose = (type: string, text = '') => {
    // Happy DOM 15 aliases CompositionEvent to Event and drops init.data.
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, 'data', { value: text });
    return textarea.dispatchEvent(event);
  };
  return { parent, textarea, position, ime, overlay, data, compose };
}

describe('IME cursor presentation', () => {
  test('keeps input focus zoom-safe across cursor updates without enlarging preedit', () => {
    const { textarea, position, ime, overlay, compose } = setup();
    position.fontSize = 12;
    compose('compositionstart');
    compose('compositionupdate', '한');
    expect(textarea.style.fontSize).toBe('16px');
    expect(overlay.style.fontSize).toBe('12px');
    ime.position({ ...position, left: 96, fontSize: 14 });
    expect(textarea.style.fontSize).toBe('16px');
    expect(textarea.style.left).toBe('96px');
    expect(overlay.style.fontSize).toBe('14px');
    ime.position({ ...position, fontSize: 20 });
    expect(textarea.style.fontSize).toBe('20px');
    expect(overlay.style.fontSize).toBe('20px');
  });

  test('open wires a real input caret, forwards parent focus, and restores host layout on dispose', async () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const terminal = await createIsolatedTerminal({ cols: 10, rows: 3 });
    cleanups.push(() => { terminal.dispose(); parent.remove(); });
    terminal.open(parent);
    const textarea = terminal.textarea!;
    expect(document.activeElement).toBe(textarea);
    expect(parent.style.position).toBe('relative');
    expect(textarea.style.clipPath).toBe('');
    expect(textarea.style.caretColor).toBe('transparent');
    expect(parseFloat(textarea.style.height)).toBeGreaterThan(1);
    terminal.blur();
    parent.focus();
    expect(document.activeElement).toBe(textarea);
    terminal.write('abc');
    const event = new Event('compositionstart', { bubbles: true });
    textarea.dispatchEvent(event);
    expect(parseFloat(textarea.style.left)).toBe(3 * terminal.renderer!.charWidth);
    terminal.dispose();
    expect(parent.style.position).toBe('');
    expect(parent.querySelector('span')).toBeNull();
  });

  test('shows uncommitted Hangul at the caret and sends nothing until commit', () => {
    const { textarea, overlay, data, compose } = setup();
    compose('compositionstart');
    compose('compositionupdate', '한');
    expect(overlay.textContent).toBe('한');
    expect(overlay.style.left).toBe('80px');
    expect(overlay.style.top).toBe('120px');
    expect(textarea.style.top).toBe('120px');
    expect(overlay.style.display).toBe('block');
    expect(data).toEqual([]);
    compose('compositionend', '한');
    expect(data).toEqual(['한']);
    expect(overlay.style.display).toBe('none');
  });

  for (const beforeFirst of [true, false]) {
    test(`commits once when beforeinput ${beforeFirst ? 'precedes' : 'follows'} compositionend`, () => {
      const { textarea, data, compose } = setup();
      compose('compositionstart');
      compose('compositionupdate', '你好');
      const beforeinput = () => textarea.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertText', data: '你好', bubbles: true, cancelable: true,
      }));
      if (beforeFirst) beforeinput();
      compose('compositionend', '你好');
      if (!beforeFirst) beforeinput();
      expect(data).toEqual(['你好']);
    });
  }

  test('tracks cursor movement and hides preedit when scrolled away', () => {
    const { position, ime, overlay, compose } = setup();
    compose('compositionstart');
    compose('compositionupdate', '가');
    ime.position({ ...position, left: 96, visible: false });
    expect(overlay.style.left).toBe('96px');
    expect(overlay.style.display).toBe('none');
    ime.position({ ...position, visible: true });
    expect(overlay.style.display).toBe('block');
  });

  test('cancellation and disposal remove preedit without emitting input', () => {
    const { ime, overlay, data, compose } = setup();
    compose('compositionstart');
    compose('compositionupdate', '<b>未</b>');
    expect(overlay.children.length).toBe(0);
    compose('compositionend');
    expect(overlay.textContent).toBe('');
    expect(data).toEqual([]);
    ime.dispose();
    expect(overlay.isConnected).toBe(false);
  });

  test('does not move the textarea while the native clipboard menu borrows it', () => {
    const { textarea, position, ime, overlay, compose } = setup();
    textarea.style.position = 'fixed';
    textarea.style.left = '250px';
    compose('compositionstart');
    compose('compositionupdate', '가');
    ime.position(position);
    expect(textarea.style.left).toBe('250px');
    expect(overlay.style.left).toBe('80px');
  });

  test('Terminal.focus targets the input, and blur releases it', () => {
    const { parent, textarea } = setup();
    // Exercise focus without a WASM/renderer dependency.
    const terminal = new Terminal({ ghostty: {} as Ghostty });
    Object.assign(terminal, { element: parent, textarea, isOpen: true });
    terminal.focus();
    expect(document.activeElement).toBe(textarea);
    terminal.blur();
    expect(document.activeElement).not.toBe(textarea);
  });

  test('repeated context menus restore the cursor anchor, including disposal before the reset timer', async () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const terminal = await createIsolatedTerminal({ cols: 10, rows: 3 });
    cleanups.push(() => { terminal.dispose(); parent.remove(); });
    terminal.open(parent);
    const textarea = terminal.textarea!;
    const canvas = terminal.renderer!.getCanvas();
    const style = textarea.style.cssText;
    const menu = (x: number) => canvas.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, clientX: x, clientY: 30,
    }));
    menu(10);
    await Bun.sleep(20);
    menu(20);
    expect(textarea.style.left).toBe('20px');
    await Bun.sleep(20);
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(textarea.style.cssText).toBe(style);
    terminal.write('abc');
    textarea.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    expect(parseFloat(textarea.style.left)).toBe(3 * terminal.renderer!.charWidth);
    menu(40);
    terminal.dispose();
    textarea.style.left = '777px';
    await Bun.sleep(20);
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(textarea.style.left).toBe('777px');
  });
});
