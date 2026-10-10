// The page: a full-window ghostty-web terminal attached to one program, or,
// with no `guest` in the URL, a launcher that lists the programs.
//
//   /?guest=repl                 which guest to run (see /guests.json)
//   &arg=a&arg=b                 extra argv entries
//   &env=KEY=value               extra environment
//   &<param>=value               a guest's own settings (opencode: server, password, dir;
//                                codex: remote, dir, sandbox); the server settings default
//                                to this origin's reverse proxy
//   &build=<name>                another build of a packaged guest (codex: names)
//   &renderer=canvas|webgl       which terminal renderer (default: WebGL unless it is software-emulated)
//   &shell=worker|inline|off     how a guest with a shell runs commands (default: shell Workers; inline on a machine with at most two cores)
//   &persist=0                   do not load or store the guest's persistent directories
//   &reset=1                     forget what was stored for this guest first
//   &signout=1                   forget only the guest's stored credentials first (codex-local: auth.json)
//
// The wiring is the whole point of this file:
//   terminal.onData  → program.write   (pty master input)
//   program output   → terminal.write  (pty master output)
//   terminal resize  → program.resize  (winsize + SIGWINCH)

import { init, Terminal } from "@random/ghostty-web";
import { type ClipboardBridge, type ExitStatus, type HttpSeen, type Program, startProgram } from "../host/index";
import { openPersistStore } from "../host/persist-store";
import { explainBlocked, originNote, requestLog } from "./direct";
import type { GuestCondition, GuestInfo } from "./guests";
import { isolate } from "./isolate";
import { showLauncher } from "./launcher";
import { installMobileControls } from "./mobile";

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
      /** Debugging: a file out of the program's filesystem as text (null = no such file), e.g.
       * `await wasmTerm.readFile("/home/user/.codex/log/codex-tui.log")`. Works after the program has exited too. */
      readFile(path: string): Promise<string | null>;
      /** Debugging: every file below a directory, with sizes. */
      listFiles(directory?: string): Promise<{ path: string; size: number }[]>;
      /** Debugging: saves a file out of the program's filesystem through the browser's download. */
      download(path: string): Promise<boolean>;
      /** How the module arrived: milliseconds from the Worker's start to each phase, and the bytes. */
      load: { downloadedMs?: number; compiledMs?: number; bytes?: number };
      /** The program's HTTP requests (`http_open`), most recent last: method, origin and path, status, and the names of
       * the response headers this page was allowed to read. No values, no query strings. */
      requests: HttpSeen[];
    };
  }
}

function fatal(message: string): never {
  const element = document.querySelector<HTMLPreElement>("#fatal")!;
  element.textContent = message;
  element.style.display = "block";
  throw new Error(message);
}

/** The static build (web/static.ts): a directory of files with no server of ours behind it. Every URL below is
 * relative to the page, so the directory works at any path; isolation and the compressed module come from the
 * page's service worker. On the dev server this is false and the server does both. */
const STATIC = process.env.WASM_TERM_STATIC === "1";
if (STATIC) await isolate("sw.js", "./").catch(error => fatal(String((error as Error).message ?? error)));

const params = new URLSearchParams(location.search);
const guests = (await (await fetch("guests.json", { cache: "no-store" })).json()) as GuestInfo[];
// A static build is for one program: its launcher is the page itself.
const guest = params.get("guest");
if (guest === null) {
  showLauncher(guests, STATIC ? { title: "codex in this tab", intro: "codex-cli 0.162.0 running entirely in this browser tab: the TUI, the agent and its tools. This page is a directory of static files; nothing of ours is behind it, and the program's requests go from this tab straight to OpenAI.", notes: [originNote(location.origin)] } : undefined);
  // Nothing below applies without a program; a module cannot return, so wait forever.
  await new Promise(() => {});
  throw new Error("unreachable");
}
const container = document.querySelector<HTMLDivElement>("#terminal")!;

if (!crossOriginIsolated) fatal("This page is not cross-origin isolated; SharedArrayBuffer is unavailable.\nServe it with COOP: same-origin and COEP: require-corp (bun web/server.ts does).");
if (!/^[\w-]+$/.test(guest)) fatal(`Bad guest name: ${guest}`);
const info: GuestInfo = guests.find(candidate => candidate.name === guest) ?? { name: guest, kind: "wasm" };

/** WebGL where there is a GPU. Without one (headless and remote-desktop browsers) the browser
 * emulates WebGL in software, slowly enough (seconds per frame, measured with codex's animated
 * start screen in headless Chrome) to starve this thread, which also carries the program's input
 * and network traffic. There the 2D canvas renderer is the fast one. `&renderer=` overrides. */
function rendererChoice(): "webgl" | "canvas" {
  const asked = params.get("renderer");
  if (asked === "canvas" || asked === "webgl") return asked;
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

await init({ wasmUrl: "ghostty-vt.wasm" });
const terminal = new Terminal({
  rendererType: rendererChoice(),
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
// A URL setting that is only a path means "on this page's origin": the dev
// server's reverse proxy, the default, which works from any device the page
// itself loads on.
const guestArgs: string[] = [];
const settings: Record<string, string> = {};
for (const param of info.params ?? []) {
  let value = params.get(param.query) ?? param.default;
  if (param.only && !param.only.includes(value)) fatal(`${param.query}=${value} is not available on this page (${param.only.join(", ")}): ${param.hint ?? ""}`);
  settings[param.query] = value;
  if (param.url && value.startsWith("/")) {
    value = new URL(value, location.origin).href.replace(/\/$/, "");
    if (param.url === "ws") value = value.replace(/^http/, "ws");
  }
  if (param.env) env[param.env] = value;
  if (param.args && value !== "") guestArgs.push(...param.args.map(arg => arg.replaceAll("{}", value)));
}

const holds = (conditions: GuestCondition[] = []) => conditions.every(condition => condition.in.includes(settings[condition.param] ?? ""));

// Files a guest wants from this server under its current settings (GuestInfo.fetchFiles).
const fetched: Record<string, Uint8Array> = {};
for (const wanted of info.fetchFiles ?? []) {
  if (!holds(wanted.when)) continue;
  try {
    const response = await fetch(wanted.url);
    if (!response.ok) continue;
    fetched[wanted.path] = new Uint8Array(await response.arrayBuffer());
    if (wanted.env) env[wanted.env] = wanted.path;
  } catch {
    // not there: the program runs without it
  }
}

const persist = params.get("persist") === "0"
  ? undefined
  : { namespace: guest, ...(info.persist ?? { roots: ["/home/user"] }) };
if (persist && params.get("reset") === "1") await openPersistStore(persist.namespace).clear();
// Sign out without the program's help: forget the stored credential files, keep everything else.
if (persist && params.get("signout") === "1") {
  const store = openPersistStore(persist.namespace);
  for (const path of info.credentials ?? []) store.save(path, null);
  await store.flush();
}

const clipboard: ClipboardBridge = {
  readText: () => navigator.clipboard.readText(),
  writeText: text => navigator.clipboard.writeText(text),
};

// A large module takes a while to arrive and compile; say so instead of showing an empty terminal.
const loading = document.querySelector<HTMLDivElement>("#loading")!;
const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
const loadStarted = performance.now();
const load: Window["wasmTerm"]["load"] = {};
let loadingShown: ReturnType<typeof setTimeout> | undefined = setTimeout(() => loading.classList.add("shown"), 300);
function hideLoading(): void {
  clearTimeout(loadingShown);
  loadingShown = undefined;
  loading.classList.remove("shown");
}

const build = params.get("build");
const moduleUrl = (build && info.builds?.[build]) || info.module || `guests/${guest}.wasm`;
// The program sends its requests straight to other origins (GuestInfo.direct): say why when the browser rejects one.
const direct = info.direct && holds(info.direct.when) ? info.direct : undefined;
const requests = requestLog();
const sent: string[] = [];
const pixels = cellPixels();
const program = startProgram({
  guestUrl: info.kind === "js" ? `guests/${guest}/guest.js` : moduleUrl,
  kernelUrl: "kernel.wasm",
  workerUrl: info.kind === "js" ? "js-worker.js" : "worker.js",
  args: [guest, ...guestArgs, ...params.getAll("arg")],
  env: { ...info.env, ...env, WASM_TERM_ORIGIN: location.origin },
  files: fetched,
  cols: terminal.cols,
  rows: terminal.rows,
  xpixel: Math.round(pixels.width * terminal.cols),
  ypixel: Math.round(pixels.height * terminal.rows),
  persist,
  // Where a program's `tcp_connect` goes: this server's TCP relay (web/tcp-relay.ts), allowlisted hosts only.
  tcpRelay: STATIC ? undefined : "/proxy/tcp",
  http: {
    seen: requests.seen,
    blocked: direct ? request => explainBlocked(request) : undefined,
    rewrite: direct && Object.fromEntries((direct.rewrite ?? []).filter(entry => holds(entry.when)).map(entry => [entry.from, entry.to])),
  },
  shell: info.kind === "wasm" && (info.shell || params.has("shell")) && params.get("shell") !== "off"
    ? { moduleUrl: "bat_sh.wasm", workerUrl: "shell-worker.js", mode: params.get("shell") === "inline" ? "inline" : params.get("shell") === "worker" ? "worker" : undefined }
    : undefined,
  // Indirect, so that replacing window.wasmTerm.clipboard takes effect.
  clipboard: {
    readText: () => window.wasmTerm.clipboard.readText(),
    writeText: text => window.wasmTerm.clipboard.writeText(text),
  },
  onOutput(data) {
    if (loadingShown !== undefined) hideLoading();
    terminal.write(data);
  },
  onLoad({ phase, loaded, total }) {
    const label = loading.querySelector<HTMLElement>(".label")!;
    const bar = loading.querySelector<HTMLElement>(".bar > div")!;
    if (phase === "download") {
      label.textContent = total ? `Loading ${guest}: ${megabytes(loaded)} of ${megabytes(total)}` : `Loading ${guest}: ${megabytes(loaded)}`;
      bar.style.width = total ? `${Math.min(100, (loaded / total) * 100).toFixed(1)}%` : "0";
    } else if (phase === "compile") {
      load.downloadedMs = Math.round(performance.now() - loadStarted);
      load.bytes = loaded;
      label.textContent = `Compiling ${guest} (${megabytes(loaded)})`;
      bar.style.width = "100%";
    } else {
      load.compiledMs = Math.round(performance.now() - loadStarted);
      label.textContent = `Starting ${guest}`;
    }
  },
  onExit(status) {
    hideLoading();
    window.wasmTerm.exit = status;
    const how = status.signal ? `killed by signal ${status.signal}` : `exit code ${status.code}`;
    const detail = status.error ? `\r\n${status.error.replaceAll(/\r?\n/g, "\r\n")}` : "";
    terminal.write(`\r\n\x1b[0m\x1b[2m[process ended: ${how}]${detail}\x1b[0m\r\n`);
  },
});

// Keystrokes, pastes (already bracketed by the terminal when the program asked
// for it), mouse reports, focus reports and query replies all arrive here as
// bytes for the pty master.
const mobile = installMobileControls(container, terminal);
terminal.onData(typed => {
  const data = mobile.input(typed);
  if (!data) return;
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
// Not on a touch device: focus there opens the on-screen keyboard over a page nobody has touched yet.
if (matchMedia("(any-pointer: coarse)").matches) terminal.textarea?.blur();
else terminal.focus();

window.wasmTerm = {
  terminal,
  program,
  sent,
  exit: null,
  clipboard,
  load,
  requests: requests.entries,
  async readFile(path) {
    const data = await program.readFile(path);
    return data && new TextDecoder().decode(data);
  },
  listFiles: (directory = "/") => program.listFiles(directory),
  async download(path) {
    const data = await program.readFile(path);
    if (!data) return false;
    const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([data as BlobPart])), download: path.split("/").pop() || "file" });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    return true;
  },
  screen() {
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < terminal.rows; row++) {
      lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
    }
    return lines;
  },
};
