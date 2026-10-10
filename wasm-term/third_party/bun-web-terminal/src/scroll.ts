// Trackpads emit many sub-line events. Preserve the fractions instead of
// turning every event into at least one application mouse/arrow event.
export class WheelAccumulator {
  private remainder = 0;
  private lastAt = 0;
  private lastMode = "";
  readonly sensitivity: number;

  constructor(sensitivity = 0.5) {
    this.sensitivity = Number.isFinite(sensitivity) && sensitivity > 0 ? sensitivity : 0.5;
  }

  steps(delta: number, deltaMode: number, lineHeight: number, rows: number, mode: string, now: number) {
    const lines = deltaMode === 1 ? delta : deltaMode === 2 ? delta * rows : delta / lineHeight;
    if (now - this.lastAt > 200 || mode !== this.lastMode || Math.sign(lines) !== Math.sign(this.remainder)) this.remainder = 0;
    this.lastAt = now;
    this.lastMode = mode;
    this.remainder += lines * this.sensitivity;
    const whole = Math.trunc(this.remainder);
    this.remainder -= whole;
    return Math.max(-8, Math.min(8, whole));
  }
}

let forwarding = false;

// Send whole wheel steps to the emulator, which retains ownership of mouse
// encoding, alternate-screen fallback, and scrollback behavior.
export function forwardWheelSteps(target: EventTarget, steps: number, init: WheelEventInit = {}) {
  forwarding = true;
  try {
    for (let i = 0; i < Math.abs(steps); i++) {
      target.dispatchEvent(new WheelEvent("wheel", { ...init, bubbles: true, cancelable: true, deltaMode: 1, deltaY: Math.sign(steps) }));
    }
  } finally { forwarding = false; }
}

export function installScrolling(container: HTMLElement, metrics: () => { lineHeight: number; rows: number; mode: string }, sensitivity = 0.5) {
  const accumulator = new WheelAccumulator(sensitivity);
  const handler = (event: WheelEvent) => {
    if (forwarding) return;
    if (event.ctrlKey) { event.stopImmediatePropagation(); return; } // Browser pinch-to-zoom.
    event.preventDefault();
    event.stopImmediatePropagation();
    const { lineHeight, rows, mode } = metrics();
    const steps = accumulator.steps(event.deltaY, event.deltaMode, lineHeight, rows, mode, performance.now());
    forwardWheelSteps(event.target ?? container, steps, {
      clientX: event.clientX, clientY: event.clientY,
      shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey,
    });
  };
  container.addEventListener("wheel", handler, { capture: true, passive: false });
  return () => container.removeEventListener("wheel", handler, { capture: true });
}
