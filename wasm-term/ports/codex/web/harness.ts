// Headless run of a wasm-term guest under Bun: the real kernel and Worker
// runtime from host/, with a headless xterm standing in for ghostty-web so
// the program gets replies to its terminal queries and the screen can be
// printed as text. For shaking out startup problems without a browser.
//
//   bun harness.ts [--cols N] [--rows N] [--guest path.wasm] [--env K=V]... [--trace] [--shell worker|inline] @@ <guest args...> ::: <steps...>
//
// --shell gives the guest the page's shell (`proc_*`): bat_sh.wasm from host/sh/dist, in Workers or inline.
//
// Steps run in order after the program starts:
//   wait:MS        sleep
//   until:TEXT     wait (up to 30 s) until TEXT is on the screen
//   type:TEXT      send TEXT one key at a time, 25 ms apart (codex treats an
//                  unbracketed burst as a paste, where Enter is a newline)
//   paste:TEXT     send TEXT at once inside bracketed-paste markers
//   burst:TEXT     send TEXT at once, unbracketed
//   key:NAME       enter | esc | tab | up | down | left | right | ctrl-c | ctrl-d | backspace
//   resize:CxR     change the window size
//   screen         print the screen
//   raw            print the bytes the program has written so far, escaped
//   cat:PATH       print a file out of the program's filesystem (e.g. its log)
//   ls:DIR         list the files below a directory of the program's filesystem
//   procs          print the child processes that have ended so far (command, status, ms)
// The screen is printed once more when the steps run out or the program exits.

import { Terminal } from "@xterm/headless";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type ExitStatus, startProgram } from "../../../host/index";

const root = join(import.meta.dir, "../../..");
const argv = process.argv.slice(2);
let cols = 100;
let rows = 30;
let guest = join(import.meta.dir, "../dist/codex.wasm");
let shell: "worker" | "inline" | undefined;
const env: Record<string, string> = {};
const files: Record<string, string> = {};
while (argv.length && argv[0] !== "@@") {
  const flag = argv.shift()!;
  if (flag === "--cols") cols = Number(argv.shift());
  else if (flag === "--rows") rows = Number(argv.shift());
  else if (flag === "--guest") guest = argv.shift()!;
  else if (flag === "--trace") env.WASM_TERM_TRACE = "1";
  else if (flag === "--shell") shell = argv.shift() as "worker" | "inline";
  else if (flag === "--env") {
    const pair = argv.shift()!;
    env[pair.slice(0, pair.indexOf("="))] = pair.slice(pair.indexOf("=") + 1);
  } else if (flag === "--file") {
    // --file /guest/path=host/path
    const pair = argv.shift()!;
    files[pair.slice(0, pair.indexOf("="))] = await Bun.file(pair.slice(pair.indexOf("=") + 1)).text();
  } else throw new Error(`unknown flag ${flag}`);
}
argv.shift();
const split = argv.indexOf(":::");
const guestArgs = split < 0 ? argv : argv.slice(0, split);
const steps = split < 0 ? [] : argv.slice(split + 1);

// host/index.ts expects a cross-origin isolated page.
Object.assign(globalThis, { crossOriginIsolated: true, location: { href: pathToFileURL(`${root}/`).href } });

const terminal = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
const raw: Uint8Array[] = [];
let exit: ExitStatus | null = null;

const program = startProgram({
  guestUrl: pathToFileURL(guest).href,
  kernelUrl: pathToFileURL(join(root, "kernel/target/wasm32-unknown-unknown/release/wasm_term_kernel.wasm")).href,
  workerUrl: join(import.meta.dir, "harness-worker.ts"),
  args: ["codex", ...guestArgs],
  env: { TERM_PROGRAM: "ghostty", ...env },
  files,
  shell: shell && { moduleUrl: pathToFileURL(join(root, "host/sh/dist/bat_sh.wasm")).href, workerUrl: join(import.meta.dir, "harness-shell-worker.ts"), mode: shell },
  cols,
  rows,
  clipboard: { readText: async () => "", writeText: async () => {} },
  onOutput(data) {
    raw.push(data.slice());
    terminal.write(data);
  },
  onExit(status) {
    exit = status;
  },
});
terminal.onData(data => program.write(data));

function screen(): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < buffer.length; row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
const flushed = () => new Promise<void>(resolve => terminal.write("", resolve));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const KEYS: Record<string, string> = {
  enter: "\r", esc: "\x1b", tab: "\t", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
  "ctrl-c": "\x03", "ctrl-d": "\x04", backspace: "\x7f", f2: "\x1bOQ",
};

async function show(title: string): Promise<void> {
  await flushed();
  console.log(`\n===== ${title} =====\n${screen()}\n=====`);
}

for (const step of steps) {
  if (exit) break;
  const colon = step.indexOf(":");
  const [kind, value] = colon < 0 ? [step, ""] : [step.slice(0, colon), step.slice(colon + 1)];
  if (kind === "wait") await sleep(Number(value));
  else if (kind === "until") {
    const deadline = Date.now() + 30_000;
    while (!exit && Date.now() < deadline) {
      await flushed();
      if (screen().includes(value)) break;
      await sleep(100);
    }
    if (!screen().includes(value)) console.log(`(until: "${value}" did not appear)`);
  } else if (kind === "type") {
    for (const char of value) {
      program.write(char);
      await sleep(25);
    }
  } else if (kind === "paste") program.write(`\x1b[200~${value}\x1b[201~`);
  else if (kind === "burst") program.write(value);
  else if (kind === "key") program.write(KEYS[value] ?? value);
  else if (kind === "resize") {
    const [c, r] = value.split("x").map(Number);
    terminal.resize(c!, r!);
    program.resize(c!, r!);
  } else if (kind === "screen") await show(`screen after ${steps.indexOf(step)} steps`);
  else if (kind === "cat") {
    const data = await program.readFile(value);
    console.log(`\n===== ${value} =====\n${data ? new TextDecoder().decode(data) : "(no such file)"}\n=====`);
  } else if (kind === "ls") {
    console.log(`\n===== ${value} =====\n${(await program.listFiles(value)).map(file => `${String(file.size).padStart(8)}  ${file.path}`).join("\n")}\n=====`);
  } else if (kind === "procs") {
    console.log(`\n===== procs =====\n${program.procs.map(proc => `${proc.status}${proc.signal ? ` (signal ${proc.signal})` : ""}  queue ${proc.queueMs.toFixed(2)} ms  run ${proc.runMs.toFixed(2)} ms  ${proc.calls} calls  ${proc.command}`).join("\n")}\n=====`);
  } else if (kind === "raw") {
    console.log(JSON.stringify(Buffer.concat(raw).toString("utf8")));
  } else throw new Error(`unknown step ${step}`);
}
if (!steps.length) await Promise.race([program.exited, sleep(10_000)]);
await show("final screen");
console.log(exit ? `exit: ${JSON.stringify(exit)}` : "exit: still running (killed by harness)");
program.kill();
process.exit(0);
