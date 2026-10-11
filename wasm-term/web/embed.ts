// The page wiring of client.ts as a function, for a page that is not this dev
// page: another app puts a JavaScript guest (the opencode TUI) into one of its
// own elements. Bundle this file for the browser and serve next to the bundle,
// under `assets`:
//
//   ghostty-vt.wasm     @random/ghostty-web's vendor/ghostty-vt.wasm (third_party/ghostty-web)
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

import type { Terminal } from "@random/ghostty-web";
import { mountDisplay } from "./display";
import { type ExitStatus, type PersistOptions, type Program, startProgram } from "../host/index";
import type { PageFetchOptions } from "../host/page-fetch";

export type { PageFetchOptions } from "../host/page-fetch";
export type { ExitStatus, Program } from "../host/index";
export { rendererChoice } from "./display";

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

export async function mountTerminal(options: MountOptions): Promise<Mounted> {
  if (!crossOriginIsolated) throw new Error("wasm-term needs a cross-origin isolated page (COOP: same-origin, COEP: require-corp)");
  const { container } = options;
  const assets = new URL(options.assets, location.href).href;
  // The display is its own component (display.ts); this file only joins it to the machine.
  let program: Program | undefined;
  const display = await mountDisplay({
    container,
    wasmUrl: `${assets}ghostty-vt.wasm`,
    renderer: options.renderer,
    fontSize: options.fontSize,
    theme: options.theme,
    onInput: data => program?.write(data),
    onResize: size => program?.resize(size.cols, size.rows, size.xpixel, size.ypixel),
  });
  const { terminal } = display;
  const pixels = display.size();

  program = startProgram({
    guestUrl: `${assets}${options.guest}/guest.js`,
    kernelUrl: `${assets}kernel.wasm`,
    workerUrl: `${assets}js-worker.js`,
    args: [options.guest, ...(options.args ?? [])],
    env: { ...options.env, WASM_TERM_ORIGIN: location.origin },
    cols: terminal.cols,
    rows: terminal.rows,
    xpixel: pixels.xpixel,
    ypixel: pixels.ypixel,
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
  return {
    terminal,
    program,
    screen: display.screen,
    dispose() {
      program?.kill();
      display.dispose();
    },
  };
}
