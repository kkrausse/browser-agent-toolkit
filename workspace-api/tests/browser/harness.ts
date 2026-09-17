import { Runtime, Workspace, opfsStore, type Distribution, type Execution } from "../../src/index.js";
import { workspaceInternals } from "../../src/workspace.js";

export function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export function equalBytes(actual: Uint8Array, expected: Uint8Array) {
  assert(actual.length === expected.length && actual.every((byte, i) => byte === expected[i]),
    `Bytes differ: actual ${JSON.stringify([...actual])}, expected ${JSON.stringify([...expected])}`);
}

// Keep event delivery ordered, including the final event before navigation.
let delivery = Promise.resolve();
export function log(kind: string, detail: unknown) {
  delivery = delivery.then(async () => {
    const response = await fetch("/events", { method: "POST", body: JSON.stringify({ kind, detail }) });
    if (!response.ok) throw new Error(`Reporter HTTP ${response.status}`);
  });
}
export function drainLogs() { return delivery; }

export async function mount(workspace: Workspace, files: Record<string, string | Uint8Array>) {
  for (const [path, bytes] of Object.entries(files)) {
    const parts = path.split("/").slice(1, -1);
    for (let i = 1; i <= parts.length; i++) await workspace.fs.mkdir("/" + parts.slice(0, i).join("/"));
    await workspace.fs.writeFile(path, bytes);
  }
}

/** Opt-in capture: slow-reader/overflow tests should consume the raw execution themselves. */
export async function capture(execution: Execution, maxBytes = 1024 * 1024) {
  async function read(stream: AsyncIterable<Uint8Array>, channel: string) {
    const chunks: Uint8Array[] = [];
    const decoder = new TextDecoder();
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      assert(size <= maxBytes, `${channel} exceeds capture limit ${maxBytes}`);
      chunks.push(chunk.slice());
      log(channel, decoder.decode(chunk, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) log(channel, tail);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  }
  const [stdout, stderr, exit] = await Promise.all([
    read(execution.stdout, "stdout"), read(execution.stderr, "stderr"), execution.exited,
  ]);
  log("exit", exit);
  return { stdout, stderr, exit };
}

/** Test-only escape hatch to the SAME host. Do not boot a second kernel or destroy it here. */
export function vivari(workspace: Workspace) {
  const state = workspaceInternals.get(workspace);
  assert(state && !state.closed, "Workspace is not open");
  return state.host;
}

export async function browserCase<T>(run: (t: {
  workspace: Workspace;
  runtime: Runtime;
}) => Promise<T>): Promise<T> {
  assert(crossOriginIsolated, "Test server must enable cross-origin isolation");
  const distribution: Distribution = await (await fetch("/distribution")).json();
  const workspace = await Workspace.open({
    id: "default", storage: opfsStore(distribution),
    onDiagnostic: event => log("diagnostic", event),
    onPersistenceChange: state => log("persistence", state),
  });
  let runtime: Runtime | undefined;
  const failures: unknown[] = [];
  let value: T | undefined;
  try {
    runtime = await Runtime.start({ workspace, distribution });
    value = await run({ workspace, runtime });
  } catch (error) { failures.push(error); }
  try { await runtime?.stop(); } catch (error) { failures.push(error); }
  try { await workspace.close(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures,
    failures.map(error => error instanceof Error ? error.stack ?? error.message : String(error)).join("\n"));
  return value as T;
}

export interface BrowserTest {
  name: string;
  // Each step runs in a fresh document, retaining this run's origin storage.
  steps: (() => Promise<void>)[];
}
