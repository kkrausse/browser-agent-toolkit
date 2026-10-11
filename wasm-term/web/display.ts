// The terminal display by itself: a ghostty-web terminal that fills an element and follows its
// size. It takes bytes to draw and reports what was typed and how many cells fit; it knows
// nothing about what runs behind it (wasm-term's machine in embed.ts, a pty of the toolkit
// runtime in examples/terminal-app, a WebSocket, a test).
//
//   const display = await mountDisplay({
//     container, wasmUrl: "/assets/ghostty-vt.wasm",
//     onInput: data => program.write(data),
//     onResize: size => program.resize(size),
//   });
//   program.onOutput = bytes => display.write(bytes);
//
// `wasmUrl` is @random/ghostty-web's vendor/ghostty-vt.wasm (third_party/ghostty-web).

import { init, Terminal } from "@random/ghostty-web";

export interface DisplaySize {
  cols: number;
  rows: number;
  /** The grid in CSS pixels (cell size times cells). */
  xpixel: number;
  ypixel: number;
}

export interface DisplayOptions {
  container: HTMLElement;
  /** URL of ghostty-vt.wasm. */
  wasmUrl: string;
  /** Keys, pastes and the terminal's own replies, as the string to send to the program. */
  onInput(data: string): void;
  /** The grid changed (the container was resized). Not called for the initial size: read `size()`. */
  onResize(size: DisplaySize): void;
  /** Default: WebGL, or the 2D canvas when the browser only emulates WebGL in software. */
  renderer?: "webgl" | "canvas";
  fontSize?: number;
  theme?: { background: string; foreground: string };
}

export interface Display {
  terminal: Terminal;
  write(data: Uint8Array | string): void;
  size(): DisplaySize;
  /** Text of the visible screen, one string per row, trailing blanks removed. */
  screen(): string[];
  focus(): void;
  dispose(): void;
}

/** Software WebGL is slow enough to starve the thread that carries the program's input. */
export function rendererChoice(): "webgl" | "canvas" {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const name = String((info && gl?.getParameter(info.UNMASKED_RENDERER_WEBGL)) ?? "");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    if (/swiftshader|llvmpipe|softpipe|software/i.test(name)) return "canvas";
  } catch {
    // no WebGL at all: the terminal falls back by itself
  }
  return "webgl";
}

export async function mountDisplay(options: DisplayOptions): Promise<Display> {
  const { container } = options;
  await init({ wasmUrl: new URL(options.wasmUrl, location.href).href });
  const terminal = new Terminal({
    rendererType: options.renderer ?? rendererChoice(),
    ctrlVPaste: false,
    cursorBlink: true,
    copyOnSelect: false,
    scrollback: 5_000,
    smoothScrollDuration: 0,
    fontSize: options.fontSize ?? 14,
    theme: options.theme ?? { background: "#16161d", foreground: "#dcd7ba" },
  });
  await terminal.open(container);

  const cell = () => {
    const metrics = terminal.renderer?.getMetrics();
    return { width: metrics?.width ?? 0, height: metrics?.height ?? 0 };
  };
  const size = (): DisplaySize => {
    const { width, height } = cell();
    return { cols: terminal.cols, rows: terminal.rows, xpixel: Math.round(width * terminal.cols), ypixel: Math.round(height * terminal.rows) };
  };
  function fit(): void {
    const { width, height } = cell();
    if (!width || !height || !container.clientWidth || !container.clientHeight) return;
    const cols = Math.max(2, Math.min(500, Math.floor((container.clientWidth + 1) / width)));
    const rows = Math.max(1, Math.min(300, Math.floor(container.clientHeight / height)));
    if (cols !== terminal.cols || rows !== terminal.rows) terminal.resize(cols, rows);
  }
  fit();

  terminal.onData(data => options.onInput(data));
  terminal.onResize(() => options.onResize(size()));
  let layoutTimer: ReturnType<typeof setTimeout> | undefined;
  const observer = new ResizeObserver(() => {
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(fit, 50);
  });
  observer.observe(container);
  terminal.focus();

  return {
    terminal,
    write: data => terminal.write(data),
    size,
    screen() {
      const buffer = terminal.buffer.active;
      const lines: string[] = [];
      for (let row = 0; row < terminal.rows; row++) lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
      return lines;
    },
    focus: () => terminal.focus(),
    dispose() {
      observer.disconnect();
      clearTimeout(layoutTimer);
      terminal.dispose();
    },
  };
}
