// The page wiring of client.ts as a function, for a page that is not this dev
// page: another app puts a JavaScript guest (the opencode TUI) into one of its
// own elements. Bundle this file for the browser and serve next to the bundle,
// under `assets`:
//
//   ghostty-vt.wasm     @random/ghostty-web's vendor/ghostty-vt.wasm
//   kernel.wasm         kernel/target/wasm32-unknown-unknown/release/wasm_term_kernel.wasm
//   js-worker.js        host/js-worker.ts, bundled (target browser, format esm)
//   <guest>/guest.js    the guest's built directory (opencode: ports/opencode/dist/site)
//
// The page must be cross-origin isolated. Unlike client.ts there is no
// launcher, no loading bar, no touch keys row and no page-level layout: the
// terminal fills `container` and follows its size.
//
//   const mounted = await mountTerminal({
//     container, assets: "/wasm-term/", guest: "opencode",
//     env: { OPENCODE_SERVER_URL: "http://opencode.in-tab", OPENCODE_SERVER_PASSWORD: "x", OPENCODE_DIRECTORY: "/workspace" },
//     pageFetch: { prefixes: ["http://opencode.in-tab"], fetch: (url, init) => inTabServer(url, init) },
//   });

import { init, Terminal } from "@random/ghostty-web";
import { type ExitStatus, type PersistOptions, type Program, startProgram } from "../host/index";
import type { PageFetchOptions } from "../host/page-fetch";

export type { PageFetchOptions } from "../host/page-fetch";
export type { ExitStatus, Program } from "../host/index";

export interface MountOptions {
  container: HTMLElement;
  /** URL of the directory holding the files listed above, ending in `/`. */
  assets: string;
  /** A JavaScript guest's directory name under `assets` (`opencode`). */
  guest: string;
  args?: string[];
  env?: Record<string, string>;
  /** Directories kept in IndexedDB across reloads. Default: none. */
  persist?: PersistOptions;
  /** Requests the page answers itself (host/page-fetch.ts). */
  pageFetch?: PageFetchOptions;
  /** Default: WebGL, or the 2D canvas when the browser only emulates WebGL in software. */
  renderer?: "webgl" | "canvas";
  fontSize?: number;
  theme?: { background: string; foreground: string };
  onExit?(status: ExitStatus): void;
}

export interface Mounted {
  terminal: Terminal;
  program: Program;
  /** Text of the visible screen, one string per row, trailing blanks removed. */
  screen(): string[];
  /** Stops the program and removes the terminal. */
  dispose(): void;
}

/** See client.ts: software WebGL is slow enough to starve the thread that carries the program's input. */
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

export async function mountTerminal(options: MountOptions): Promise<Mounted> {
  if (!crossOriginIsolated) throw new Error("wasm-term needs a cross-origin isolated page (COOP: same-origin, COEP: require-corp)");
  const { container } = options;
  const assets = new URL(options.assets, location.href).href;
  await init({ wasmUrl: `${assets}ghostty-vt.wasm` });
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
  function fit(): void {
    const { width, height } = cell();
    if (!width || !height || !container.clientWidth || !container.clientHeight) return;
    const cols = Math.max(2, Math.min(500, Math.floor((container.clientWidth + 1) / width)));
    const rows = Math.max(1, Math.min(300, Math.floor(container.clientHeight / height)));
    if (cols !== terminal.cols || rows !== terminal.rows) terminal.resize(cols, rows);
  }
  fit();

  const pixels = cell();
  const program = startProgram({
    guestUrl: `${assets}${options.guest}/guest.js`,
    kernelUrl: `${assets}kernel.wasm`,
    workerUrl: `${assets}js-worker.js`,
    args: [options.guest, ...(options.args ?? [])],
    env: { ...options.env, WASM_TERM_ORIGIN: location.origin },
    cols: terminal.cols,
    rows: terminal.rows,
    xpixel: Math.round(pixels.width * terminal.cols),
    ypixel: Math.round(pixels.height * terminal.rows),
    persist: options.persist,
    pageFetch: options.pageFetch,
    onOutput: data => terminal.write(data),
    onExit(status) {
      const how = status.signal ? `killed by signal ${status.signal}` : `exit code ${status.code}`;
      const detail = status.error ? `\r\n${status.error.replaceAll(/\r?\n/g, "\r\n")}` : "";
      terminal.write(`\r\n\x1b[0m\x1b[2m[process ended: ${how}]${detail}\x1b[0m\r\n`);
      options.onExit?.(status);
    },
  });
  terminal.onData(data => program.write(data));
  terminal.onResize(({ cols, rows }) => {
    const { width, height } = cell();
    program.resize(cols, rows, Math.round(width * cols), Math.round(height * rows));
  });
  let layoutTimer: ReturnType<typeof setTimeout> | undefined;
  const observer = new ResizeObserver(() => {
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(fit, 50);
  });
  observer.observe(container);
  terminal.focus();

  return {
    terminal,
    program,
    screen() {
      const buffer = terminal.buffer.active;
      const lines: string[] = [];
      for (let row = 0; row < terminal.rows; row++) lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
      return lines;
    },
    dispose() {
      observer.disconnect();
      clearTimeout(layoutTimer);
      program.kill();
      terminal.dispose();
    },
  };
}
