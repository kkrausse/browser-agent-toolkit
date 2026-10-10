import type { Terminal } from "@random/ghostty-web";

// Long presses follow desktop drag routing; the Select toolbar forces local selection.
// Swipes report whole lines through `scroll` (positive is toward newer output):
// the text follows the finger one line per line height, then coasts on release.
export function installTerminalTouchControls(container: HTMLElement, terminal: Terminal, selecting: () => boolean, notice: (message: string) => void, scroll: (lines: number, x: number, y: number) => void, openLink: (x: number, y: number) => boolean = () => false) {
  let gesture: { id: number; x: number; y: number; lastX: number; lastY: number; moved: boolean; anchor: number; selecting: boolean; application: boolean } | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const clearHold = () => { clearTimeout(holdTimer); holdTimer = undefined; };
  let pixels = 0; // Finger travel not yet amounting to a whole line.
  let samples: { at: number; y: number }[] = [];
  let fling = 0; // Identifies the running coast; 0 when idle.
  let flings = 0;
  const nextFrame = (callback: () => void) => typeof requestAnimationFrame === "function" ? requestAnimationFrame(callback) : setTimeout(callback, 16);
  const scrollBy = (distance: number, x: number, y: number) => {
    const lineHeight = terminal.renderer!.getMetrics().height;
    pixels += distance;
    const lines = Math.trunc(pixels / lineHeight);
    if (!lines) return;
    pixels -= lines * lineHeight;
    scroll(lines, x, y);
  };
  const coast = (velocity: number, x: number, y: number) => {
    const id = fling = ++flings;
    let last = performance.now();
    const frame = () => {
      if (fling !== id) return;
      const now = performance.now();
      const elapsed = Math.min(now - last, 50);
      last = now;
      scrollBy(velocity * elapsed, x, y);
      // Native-feeling decay: speed falls by 1/e every 325 ms.
      velocity *= Math.exp(-elapsed / 325);
      if (Math.abs(velocity) < 0.03) fling = 0;
      else nextFrame(frame);
    };
    nextFrame(frame);
  };
  const mouse = (type: string, x: number, y: number) => container.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, button: 0, buttons: type === "mouseup" ? 0 : 1,
    clientX: x, clientY: y,
  }));
  const cancel = () => {
    clearHold();
    // Balance an application press even on multi-touch, suspension or touchcancel.
    if (gesture?.application) mouse("mouseup", gesture.lastX, gesture.lastY);
    gesture = undefined;
  };
  const cellAt = (x: number, y: number) => {
    const rect = container.querySelector("canvas")!.getBoundingClientRect();
    const metrics = terminal.renderer!.getMetrics();
    const col = Math.max(0, Math.min(terminal.cols - 1, Math.floor((x - rect.left) / metrics.width)));
    const row = Math.max(0, Math.min(terminal.rows - 1, Math.floor((y - rect.top) / metrics.height)));
    return row * terminal.cols + col;
  };
  const selectTo = (end: number) => {
    if (!gesture) return;
    const start = Math.min(gesture.anchor, end);
    terminal.select(start % terminal.cols, Math.floor(start / terminal.cols), Math.abs(end - gesture.anchor) + 1);
  };
  container.addEventListener("touchstart", (event) => {
    // Claim touches before the engine can turn them into clicks or focus changes.
    event.stopImmediatePropagation();
    // Touching a coasting terminal stops it; that touch must not also click.
    const coasting = fling !== 0;
    fling = 0;
    pixels = 0;
    samples = [];
    cancel();
    if (event.touches.length !== 1) return;
    const touch = event.touches[0]!;
    gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastY: touch.clientY,
      moved: coasting, anchor: cellAt(touch.clientX, touch.clientY), selecting: selecting(), application: false };
    if (gesture.selecting) selectTo(gesture.anchor);
    else holdTimer = setTimeout(() => {
      holdTimer = undefined;
      if (!gesture) return;
      gesture.selecting = true;
      gesture.application = !terminal.options.selectOnDrag && !!terminal.wasmTerm?.hasMouseTracking();
      if (gesture.application) {
        // Use Ghostty's normal mouse encoding and the same inner-pane mode as desktop.
        mouse("mousedown", gesture.x, gesture.y);
      } else selectTo(gesture.anchor);
      // Keep keyboard/viewport geometry stable while the finger is down.
      notice(gesture.application ? "Drag to select in application" : "Drag to select");
    }, 500);
  }, { capture: true, passive: true });
  container.addEventListener("touchmove", (event) => {
    event.stopImmediatePropagation();
    if (!gesture || event.touches.length !== 1) { cancel(); return; }
    event.preventDefault();
    const touch = [...event.touches].find((touch) => touch.identifier === gesture!.id);
    if (!touch) return;
    if (!gesture.selecting && !gesture.moved && Math.hypot(touch.clientX - gesture.x, touch.clientY - gesture.y) < 8) return;
    clearHold();
    gesture.moved = true;
    if (gesture.selecting) {
      if (gesture.application) mouse("mousemove", touch.clientX, touch.clientY);
      else selectTo(cellAt(touch.clientX, touch.clientY));
    } else {
      const now = performance.now();
      samples = [...samples.filter(sample => now - sample.at <= 80), { at: now, y: touch.clientY }];
      scrollBy(gesture.lastY - touch.clientY, touch.clientX, touch.clientY);
    }
    gesture.lastX = touch.clientX;
    gesture.lastY = touch.clientY;
  }, { capture: true, passive: false });
  container.addEventListener("touchend", (event) => {
    event.stopImmediatePropagation();
    // Suppress compatibility mouse events, including after multi-touch cancellation.
    event.preventDefault();
    clearHold();
    if (gesture?.selecting) {
      const touch = [...event.changedTouches].find((touch) => touch.identifier === gesture!.id);
      if (touch) {
        if (gesture.application) {
          if (touch.clientX !== gesture.lastX || touch.clientY !== gesture.lastY) mouse("mousemove", touch.clientX, touch.clientY);
          gesture.lastX = touch.clientX;
          gesture.lastY = touch.clientY;
        } else selectTo(cellAt(touch.clientX, touch.clientY));
      }
    } else if (gesture?.moved) {
      // Coast at the speed of the last 80 ms; a finger that paused first has none.
      const now = performance.now();
      const recent = samples.filter(sample => now - sample.at <= 80);
      const first = recent[0], last = recent.at(-1);
      if (first && last && last.at - first.at >= 10) {
        const velocity = Math.max(-6, Math.min(6, (first.y - last.y) / (last.at - first.at)));
        if (Math.abs(velocity) > 0.15) coast(velocity, gesture.lastX, gesture.lastY);
      }
    } else if (gesture) {
      if (openLink(gesture.x, gesture.y)) { cancel(); return; }
      // Defer the entire click until release: a swipe must never press a TUI row.
      // Bypass the canvas focus listener so taps don't summon the software keyboard.
      for (const type of ["mousedown", "mouseup"]) {
        mouse(type, gesture.x, gesture.y);
      }
    }
    cancel();
  }, { capture: true, passive: false });
  const halt = () => { fling = 0; cancel(); };
  container.addEventListener("touchcancel", halt, { capture: true });
  container.addEventListener("contextmenu", (event) => {
    // Native long-press menus can cancel the drag before selection starts.
    if (gesture) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, { capture: true });
  window.addEventListener("blur", halt);
  window.addEventListener("pagehide", halt);
  document.addEventListener("visibilitychange", () => { if (document.hidden) halt(); });
}
