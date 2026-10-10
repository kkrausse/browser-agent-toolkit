// CPU profile of a guest's Worker in a private headless Chrome (not the shared
// one): Chrome's tracing with the V8 sampling profiler, which names wasm
// functions from the module's name section. Prints where the guest's thread
// spent its time, as a top-down tree, and the longest stretches in which the
// thread never went idle (a "stall": input is not processed meanwhile).
//
//   cd wasm-term/web && bun verify/profile.ts [url] [--seconds N] [--min-ms N] [--out trace.json] [--burst TEXT] [--blocked] [--sum NAME=REGEX]...
//
// --sum adds one line per pattern: the thread's busy time in samples whose stack has a frame
// matching it (e.g. --sum 'tls=rustls|aws_lc' for what TLS inside the module costs).
//
// The URL should load a build that kept its names, e.g.
//   http://127.0.0.1:4790/?guest=codex&build=names&persist=0

import { chromium } from "playwright";

const argv = process.argv.slice(2);
let url = "http://127.0.0.1:4790/?guest=codex&build=names&persist=0";
let seconds = 8;
let minMs = 15;
let out = "";
/** Sent in one write as soon as there is text on the screen, with Enter 1.5 s later. */
let burst = "";
/** Also print where the thread was blocked (waiting in a host call), which is where input goes unread if the call does not watch the terminal. */
let showBlocked = false;
/** name -> pattern over a stack's function names. */
const sums: [string, RegExp][] = [];
while (argv.length) {
  const arg = argv.shift()!;
  if (arg === "--seconds") seconds = Number(argv.shift());
  else if (arg === "--min-ms") minMs = Number(argv.shift());
  else if (arg === "--out") out = argv.shift()!;
  else if (arg === "--burst") burst = argv.shift()!;
  else if (arg === "--blocked") showBlocked = true;
  else if (arg === "--sum") {
    const [name, ...pattern] = argv.shift()!.split("=");
    sums.push([name!, new RegExp(pattern.join("="))]);
  }
  else url = arg;
}

interface CallFrame { functionName: string; url?: string; scriptId?: number | string }
interface ProfileNode { id: number; parent?: number; callFrame: CallFrame }
interface TraceEvent {
  name: string; ph: string; pid: number; tid: number; ts: number; id?: string;
  args?: { data?: { startTime?: number; cpuProfile?: { nodes?: ProfileNode[]; samples?: number[] }; timeDeltas?: number[] } };
}

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--ignore-certificate-errors"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await browser.startTracing(page, { categories: ["disabled-by-default-v8.cpu_profiler", "v8", "devtools.timeline"] });
const started = Date.now();
await page.goto(url);
await page.waitForFunction(() => (window as unknown as { wasmTerm?: { screen(): string[] } }).wasmTerm?.screen().some(line => line.trim().length > 0), undefined, { timeout: 180_000 });
const painted = Date.now();
if (burst) {
  await page.evaluate(text => (window as unknown as { wasmTerm: { program: { write(data: string): void } } }).wasmTerm.program.write(text), burst);
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as unknown as { wasmTerm: { program: { write(data: string): void } } }).wasmTerm.program.write("\r"));
}
await page.waitForTimeout(seconds * 1000);
const screen = await page.evaluate(() => (window as unknown as { wasmTerm: { screen(): string[] } }).wasmTerm.screen().join("\n"));
const buffer = await browser.stopTracing();
await browser.close();
if (out) await Bun.write(out, buffer);
console.log(`first text on screen ${painted - started} ms after navigation; traced ${seconds} s more\n`);
console.log(screen.split("\n").filter(line => line.trim()).slice(-8).join("\n"), "\n");

const events = (JSON.parse(buffer.toString()) as { traceEvents: TraceEvent[] }).traceEvents;

// One profile per thread: nodes arrive in chunks, samples reference node ids.
interface Profile { nodes: Map<number, ProfileNode>; samples: number[]; deltas: number[]; start: number }
const profiles = new Map<string, Profile>();
for (const event of events) {
  if (event.name !== "Profile" && event.name !== "ProfileChunk") continue;
  const key = `${event.pid}:${event.id}`;
  let profile = profiles.get(key);
  if (!profile) profiles.set(key, profile = { nodes: new Map(), samples: [], deltas: [], start: 0 });
  const data = event.args?.data;
  if (event.name === "Profile") profile.start = data?.startTime ?? event.ts;
  for (const node of data?.cpuProfile?.nodes ?? []) profile.nodes.set(node.id, node);
  profile.samples.push(...(data?.cpuProfile?.samples ?? []));
  profile.deltas.push(...(data?.timeDeltas ?? []));
}

const isIdle = (name: string) => name === "(idle)" || name === "(program)" || name === "(root)" || name === "(garbage collector)";
// A wasm frame's url is the module's (the kernel is a module too; the guest is the big one).
const wasmSamples = (profile: Profile) => profile.samples.filter(id => /\/guests\/[^?]*\.wasm/.test(String(profile.nodes.get(id)?.callFrame.url ?? ""))).length;
// The guest's thread is the one with the most samples in wasm code.
const guest = [...profiles.values()].sort((a, b) => wasmSamples(b) - wasmSamples(a))[0];
if (!guest || !wasmSamples(guest)) {
  console.log("no wasm samples in the trace");
  process.exit(1);
}

function stack(profile: Profile, id: number): string[] {
  const frames: string[] = [];
  for (let node = profile.nodes.get(id); node; node = node.parent === undefined ? undefined : profile.nodes.get(node.parent)) {
    frames.push(node.callFrame.functionName || "(anonymous)");
  }
  return frames.reverse();
}

// Busy stretches: consecutive samples that are not idle. Atomics.wait shows as a
// native frame under the import, so a blocked guest counts as idle too.
const blocked = (frames: string[]) => frames[frames.length - 1] === "wait" || isIdle(frames[frames.length - 1]!);
interface Stretch { from: number; to: number; samples: number[] }
const stretches: Stretch[] = [];
const waiting: number[] = [];
let time = guest.start;
let current: Stretch | null = null;
for (let index = 0; index < guest.samples.length; index++) {
  time += guest.deltas[index] ?? 0;
  const frames = stack(guest, guest.samples[index]!);
  if (blocked(frames)) {
    if (frames[frames.length - 1] === "wait") waiting.push(index);
    if (current) stretches.push(current);
    current = null;
  } else {
    current ??= { from: time, to: time, samples: [] };
    current.to = time;
    current.samples.push(index);
  }
}
if (current) stretches.push(current);
stretches.sort((a, b) => (b.to - b.from) - (a.to - a.from));

interface Tree { name: string; micros: number; children: Map<string, Tree> }
function tree(indexes: number[]): Tree {
  const root: Tree = { name: "(thread)", micros: 0, children: new Map() };
  for (const index of indexes) {
    const micros = guest!.deltas[index] ?? 0;
    let node = root;
    node.micros += micros;
    for (const frame of stack(guest!, guest!.samples[index]!)) {
      let child = node.children.get(frame);
      if (!child) node.children.set(frame, child = { name: frame, micros: 0, children: new Map() });
      child.micros += micros;
      node = child;
    }
  }
  return root;
}
function print(node: Tree, depth: number): void {
  if (node.micros / 1000 < minMs) return;
  console.log(`${"  ".repeat(depth)}${(node.micros / 1000).toFixed(0).padStart(5)} ms  ${node.name.slice(0, 150)}`);
  // A chain of single children is one line of interest; do not indent it away.
  for (const child of [...node.children.values()].sort((a, b) => b.micros - a.micros)) print(child, depth + 1);
}

const origin = guest.start;
console.log(`guest thread: ${guest.samples.length} samples. Longest stretches without going idle:`);
for (const stretch of stretches.slice(0, 5)) {
  console.log(`  ${((stretch.to - stretch.from) / 1000).toFixed(0)} ms, from ${((stretch.from - origin) / 1000).toFixed(0)} ms after the profile started`);
}
for (const stretch of stretches.slice(0, 3)) {
  if ((stretch.to - stretch.from) / 1000 < 100) break;
  console.log(`\n--- ${((stretch.to - stretch.from) / 1000).toFixed(0)} ms stretch at +${((stretch.from - origin) / 1000).toFixed(0)} ms ---`);
  print(tree(stretch.samples), 0);
}
if (showBlocked) {
  console.log("\n--- blocked in a host call (whole trace) ---");
  print(tree(waiting), 0);
}

if (sums.length) {
  const busy = stretches.flatMap(stretch => stretch.samples);
  const micros = (indexes: number[]) => indexes.reduce((sum, index) => sum + (guest.deltas[index] ?? 0), 0);
  console.log(`\n--- sums over the whole trace ---\n${(micros(busy) / 1000).toFixed(0).padStart(6)} ms  busy (not idle, not blocked in a host call)`);
  for (const [name, pattern] of sums) {
    const matching = busy.filter(index => stack(guest, guest.samples[index]!).some(frame => pattern.test(frame)));
    console.log(`${(micros(matching) / 1000).toFixed(0).padStart(6)} ms  ${name} (a frame matching /${pattern.source}/ on the stack)`);
  }
}
