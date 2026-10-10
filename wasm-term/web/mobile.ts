// Touch devices: no hardware keyboard, a viewport the on-screen keyboard
// shrinks, and fingers instead of a wheel. This is the minimum that makes a
// TUI operable from a phone, done the way bun-web-terminal does it
// (the same ghostty-web package on a phone, in daily use). Its touch gestures,
// viewport rule and wheel forwarding are imported as they are (the three files
// in ../third_party/bun-web-terminal, a snapshot); only the keys
// row is local, because its one (installMobileControls) is tied to that app's
// connection, dictation and file upload.
//
//   - body follows visualViewport, so the terminal and the keys row stay above
//     the on-screen keyboard and the grid is refitted (ResizeObserver in client.ts);
//   - a swipe scrolls: whole lines as wheel steps, which the emulator turns into
//     mouse reports, arrow keys (alternate screen) or scrollback;
//   - a tap is a click for the program; a long press then drag selects;
//   - a compact row of keys a phone keyboard lacks (Esc, Ctrl, Tab, arrows, Shift+Enter). A tap on the terminal does
//     not open the keyboard (it would on every click in a TUI): the first key does.

import type { Terminal } from "@random/ghostty-web";
import { forwardWheelSteps } from "../third_party/bun-web-terminal/src/scroll";
import { installTerminalTouchControls } from "../third_party/bun-web-terminal/src/touch";
import { terminalViewport } from "../third_party/bun-web-terminal/src/viewport";

export interface MobileControls {
  /** Applies a pending Ctrl from the keys row to typed input: returns what to send, or "" when it was sent as a key. */
  input(data: string): string;
}

// Lucide "keyboard" (ISC license), as in bun-web-terminal.
const KEYBOARD_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M8 17h8"/></svg>';

const KEYS: [key: string, label: string][] = [
  ["Keyboard", KEYBOARD_ICON], ["Escape", "Esc"], ["Control", "Ctrl"], ["Tab", "Tab"],
  ["ArrowLeft", "←"], ["ArrowDown", "↓"], ["ArrowUp", "↑"], ["ArrowRight", "→"],
  // Shift+Enter: a newline in the prompt of codex and opencode, where the on-screen keyboard's Enter submits.
  ["ShiftEnter", "⇧↵"],
];

export function installMobileControls(container: HTMLElement, terminal: Terminal): MobileControls {
  const toolbar = document.createElement("div");
  toolbar.className = "terminal-keys";
  toolbar.setAttribute("role", "group");
  toolbar.setAttribute("aria-label", "Terminal extra keys");
  for (const [key, label] of KEYS) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.key = key;
    button.innerHTML = label;
    button.setAttribute("aria-label", key === "ShiftEnter" ? "Shift Enter (new line)" : key.replace("Arrow", "Arrow "));
    if (key === "Control") button.setAttribute("aria-pressed", "false");
    toolbar.append(button);
  }
  container.after(toolbar);

  let control = false;
  const setControl = (value: boolean) => {
    control = value;
    toolbar.querySelector('[data-key="Control"]')!.setAttribute("aria-pressed", String(value));
  };
  // The emulator encodes it for whatever keyboard protocol the program asked for.
  const sendKey = (key: string, code: string, ctrlKey: boolean, shiftKey = false) => {
    terminal.textarea?.dispatchEvent(new KeyboardEvent("keydown", { key, code, ctrlKey, shiftKey, bubbles: true, cancelable: true }));
  };

  const activate = (key: string) => {
    if (key === "Keyboard") {
      if (document.activeElement === terminal.textarea) terminal.textarea?.blur();
      else terminal.textarea?.focus({ preventScroll: true });
      return;
    }
    if (key === "Control") { setControl(!control); return; }
    const ctrlKey = control;
    setControl(false);
    if (key === "ShiftEnter") sendKey("Enter", "Enter", ctrlKey, true);
    else sendKey(key, key, ctrlKey);
  };
  const keyOf = (event: Event) => (event.target as HTMLElement).closest<HTMLButtonElement>("button")?.dataset.key;
  // Prevent pointer focus from dismissing the keyboard. Engines disagree on whether a
  // click still follows a prevented pointerdown (iOS Safari: yes; WebKit's WPE port: no),
  // so a key acts on pointerup and a click that does follow is ignored.
  let down: string | undefined;
  let actedAt = 0;
  toolbar.addEventListener("pointerdown", event => { event.preventDefault(); down = keyOf(event); });
  toolbar.addEventListener("pointercancel", () => { down = undefined; });
  toolbar.addEventListener("pointerup", event => {
    const key = keyOf(event);
    if (key && key === down) { actedAt = performance.now(); activate(key); }
    down = undefined;
  });
  // Without a pointer: assistive technology, a hardware keyboard's Enter/Space.
  toolbar.addEventListener("click", event => {
    const key = keyOf(event);
    if (key && performance.now() - actedAt > 700) activate(key);
  });

  const canvas = () => container.querySelector("canvas") ?? container;
  installTerminalTouchControls(container, terminal, () => false, () => {}, (lines, x, y) => {
    forwardWheelSteps(canvas(), lines, { clientX: x, clientY: y });
  });

  // visualViewport shrinks with the software keyboard even when 100dvh does not.
  const viewport = window.visualViewport;
  const layout = () => {
    const { height, top } = terminalViewport(viewport, window.innerHeight);
    document.body.style.height = `${height}px`;
    document.body.style.top = `${top}px`;
  };
  let layoutFrame = 0;
  const scheduleLayout = () => {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => { layoutFrame = 0; layout(); });
  };
  viewport?.addEventListener("resize", scheduleLayout);
  viewport?.addEventListener("scroll", scheduleLayout);
  window.addEventListener("resize", scheduleLayout);
  window.addEventListener("pageshow", scheduleLayout);
  container.addEventListener("focusin", scheduleLayout);
  container.addEventListener("focusout", scheduleLayout);
  window.addEventListener("blur", () => setControl(false));
  layout();

  return {
    input(data) {
      if (!control) return data;
      setControl(false);
      // One typed character with Ctrl pending becomes that key chord.
      if (data.length !== 1) return data;
      if (/[a-z]/i.test(data)) {
        sendKey(data.toLowerCase(), `Key${data.toUpperCase()}`, true);
        return "";
      }
      const code = data.charCodeAt(0);
      if (code >= 64 && code <= 95) return String.fromCharCode(code & 31);
      if (data === " ") return "\x00";
      if (data === "?") return "\x7f";
      return data;
    },
  };
}
