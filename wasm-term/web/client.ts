// The page: a full-window ghostty-web terminal attached to one program, or,
// with no `guest` in the URL, a launcher that lists the programs.
//
//   /?guest=repl                 which guest to run (see /guests.json)
//   &arg=a&arg=b                 extra argv entries
//   &env=KEY=value               extra environment
//   &<param>=value               a guest's own settings (opencode: server, password, dir)
//   &persist=0                   do not load or store the guest's persistent directories
//   &reset=1                     forget what was stored for this guest first
//
// The wiring is the whole point of this file:
//   terminal.onData  → program.write   (pty master input)
//   program output   → terminal.write  (pty master output)
//   terminal resize  → program.resize  (winsize + SIGWINCH)

import { init, Terminal } from "@random/ghostty-web";
import { type ClipboardBridge, type ExitStatus, type Program, startProgram } from "../host/index";
import { openPersistStore } from "../host/persist-store";
import type { GuestInfo } from "./guests";
import { showLauncher } from "./launcher";

declare global {
  interface Window {
    /** Hooks for driving and inspecting the page from tests and the console. */
    wasmTerm: {
      terminal: Terminal;
      program: Program;
      /** Text of the visible screen, one string per row, trailing blanks removed. */
      screen(): string[];
      /** Every string the terminal sent to the program, most recent last. */
      sent: string[];
      exit: ExitStatus | null;
      /** What programs get as the system clipboard; replaceable (tests, browsers without the async clipboard API). */
      clipboard: ClipboardBridge;
    };
  }
}

const params = new URLSearchParams(location.search);
const guests = (await (await fetch("/guests.json")).json()) as GuestInfo[];
const guest = params.get("guest");
if (guest === null) {
  showLauncher(guests);
  // Nothing below applies without a program; a module cannot return, so wait forever.
  await new Promise(() => {});
  throw new Error("unreachable");
}
const container = document.querySelector<HTMLDivElement>("#terminal")!;

function fatal(message: string): never {
  const element = document.querySelector<HTMLPreElement>("#fatal")!;
  element.textContent = message;
  element.style.display = "block";
  throw new Error(message);
}

if (!crossOriginIsolated) fatal("This page is not cross-origin isolated; SharedArrayBuffer is unavailable.\nServe it with COOP: same-origin and COEP: require-corp (bun web/server.ts does).");
if (!/^[\w-]+$/.test(guest)) fatal(`Bad guest name: ${guest}`);
const info: GuestInfo = guests.find(candidate => candidate.name === guest) ?? { name: guest, kind: "wasm" };

await init();
const terminal = new Terminal({
  rendererType: "webgl",
  // Ctrl+V is the terminal's literal-next key (and a key binding in many TUIs),
  // not paste: paste stays on Cmd+V / Ctrl+Shift+V and the browser's paste event.
  ctrlVPaste: false,
  cursorBlink: true,
  copyOnSelect: false,
  scrollback: 5_000,
  smoothScrollDuration: 0,
  fontSize: 15,
  theme: { background: "#16161d", foreground: "#dcd7ba" },
});
await terminal.open(container);

function cellPixels(): { width: number; height: number } {
  const metrics = terminal.renderer?.getMetrics();
  return { width: metrics?.width ?? 0, height: metrics?.height ?? 0 };
}

function fit(): void {
  const { width, height } = cellPixels();
  if (!width || !height || !container.clientWidth || !container.clientHeight) return;
  const cols = Math.max(2, Math.min(500, Math.floor((container.clientWidth + 1) / width)));
  const rows = Math.max(1, Math.min(300, Math.floor(container.clientHeight / height)));
  if (cols !== terminal.cols || rows !== terminal.rows) terminal.resize(cols, rows);
}
fit();

const env: Record<string, string> = {};
for (const pair of params.getAll("env")) {
  const equals = pair.indexOf("=");
  if (equals > 0) env[pair.slice(0, equals)] = pair.slice(equals + 1);
}

// A guest's own settings arrive as environment variables.
for (const param of info.params ?? []) env[param.env] = params.get(param.query) ?? param.default;

const persist = params.get("persist") === "0"
  ? undefined
  : { namespace: guest, ...(info.persist ?? { roots: ["/home/user"] }) };
if (persist && params.get("reset") === "1") await openPersistStore(persist.namespace).clear();

const clipboard: ClipboardBridge = {
  readText: () => navigator.clipboard.readText(),
  writeText: text => navigator.clipboard.writeText(text),
};

const sent: string[] = [];
const pixels = cellPixels();
const program = startProgram({
  guestUrl: info.kind === "js" ? `/guests/${guest}/guest.js` : `/guests/${guest}.wasm`,
  kernelUrl: "/kernel.wasm",
  workerUrl: info.kind === "js" ? "/js-worker.js" : "/worker.js",
  args: [guest, ...params.getAll("arg")],
  env: { ...env, WASM_TERM_ORIGIN: location.origin },
  cols: terminal.cols,
  rows: terminal.rows,
  xpixel: Math.round(pixels.width * terminal.cols),
  ypixel: Math.round(pixels.height * terminal.rows),
  persist,
  // Indirect, so that replacing window.wasmTerm.clipboard takes effect.
  clipboard: {
    readText: () => window.wasmTerm.clipboard.readText(),
    writeText: text => window.wasmTerm.clipboard.writeText(text),
  },
  onOutput: data => terminal.write(data),
  onExit(status) {
    window.wasmTerm.exit = status;
    const how = status.signal ? `killed by signal ${status.signal}` : `exit code ${status.code}`;
    const detail = status.error ? `\r\n${status.error.replaceAll(/\r?\n/g, "\r\n")}` : "";
    terminal.write(`\r\n\x1b[0m\x1b[2m[process ended: ${how}]${detail}\x1b[0m\r\n`);
  },
});

// Keystrokes, pastes (already bracketed by the terminal when the program asked
// for it), mouse reports, focus reports and query replies all arrive here as
// bytes for the pty master.
terminal.onData(data => {
  sent.push(data);
  if (sent.length > 200) sent.shift();
  program.write(data);
});

terminal.onResize(({ cols, rows }) => {
  const { width, height } = cellPixels();
  program.resize(cols, rows, Math.round(width * cols), Math.round(height * rows));
});

let layoutTimer: ReturnType<typeof setTimeout> | undefined;
new ResizeObserver(() => {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(fit, 50);
}).observe(container);

terminal.onTitleChange(title => {
  document.title = title || "wasm-term";
});
terminal.focus();

window.wasmTerm = {
  terminal,
  program,
  sent,
  exit: null,
  clipboard,
  screen() {
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < terminal.rows; row++) {
      lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
    }
    return lines;
  },
};
