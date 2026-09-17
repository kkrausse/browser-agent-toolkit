import { Runtime, type Distribution, type Execution } from "../../src/index.js";
import { assert, browserCase, capture, equalBytes, mount, type BrowserTest } from "./harness.js";

const encoder = new TextEncoder();

async function bounded<T>(promise: PromiseLike<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function rejectsCode(promise: PromiseLike<unknown>, code: string) {
  let rejected = false;
  try { await bounded(promise, `expected ${code}`); }
  catch (error) {
    rejected = true;
    assert(typeof error === "object" && error !== null && "code" in error && error.code === code,
      `Expected ${code}, received ${String(error)}`);
  }
  assert(rejected, `Expected rejection ${code}`);
}

async function readBytes(stream: AsyncIterable<Uint8Array>) {
  const bytes: number[] = [];
  for await (const chunk of stream) {
    assert(bytes.length + chunk.length <= 1024 * 1024, "Unexpected output exceeds 1 MiB");
    for (const byte of chunk) bytes.push(byte);
  }
  return new Uint8Array(bytes);
}

function forced(exit: Awaited<Execution["exited"]>) {
  assert(exit.forced === true && exit.signal === "SIGTERM" && exit.exitCode === 143,
    `Expected forced SIGTERM/143, received ${JSON.stringify(exit)}`);
}

const childServer = `
  require('node:http').createServer((req, res) => res.end('child-alive')).listen(3241);
`;
const parent = `
  require('node:child_process').spawn('node', ['/workspace/process-child.cjs'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  setInterval(() => {}, 1000);
`;

export const processTests: BrowserTest[] = [
  {
    name: "unread stdout overflow is retained after forced execution teardown",
    steps: [() => browserCase(async ({ workspace, runtime }) => {
      await mount(workspace, { "/process-overflow.cjs": `
        process.stdin.once('data', () => {
          for (let i = 0; i < 256; i++) process.stdout.write(Buffer.alloc(16384, 255));
        });
        process.stdin.resume();
        setInterval(() => {}, 1000);
      ` });
      const execution = await runtime.node({ entry: "/workspace/process-overflow.cjs" });
      execution.writeStdin(encoder.encode("go"));
      // Do not claim/read stdout until the process has exited: capture would mask overflow.
      const exit = await bounded(execution.exited, "unread stdout forces exit");
      forced(exit);
      await rejectsCode(readBytes(execution.stdout), "OUTPUT_OVERFLOW");
      equalBytes(await bounded(readBytes(execution.stderr), "unaffected stderr EOF"), new Uint8Array());
      await bounded(Promise.all([execution.stop(), execution.stop()]), "idempotent stop after overflow");
      assert(await execution.exited === exit, "Exit metadata changed after repeated stop");
    })],
  },
  ...(["stdout", "stderr"] as const).map((channel): BrowserTest => ({
    name: `cancelling ${channel} discards output without killing execution`,
    steps: [() => browserCase(async ({ workspace, runtime }) => {
      const other = channel === "stdout" ? "stderr" : "stdout";
      await mount(workspace, { "/process-cancel.cjs": `
        process.${channel}.write(Buffer.from([0, 255, 128, 65]));
        process.stdin.on('data', () => {
          process.${channel}.write(Buffer.from([254, 0, 129]));
          process.${other}.write(Buffer.from([0, 128, 255, 66]));
        });
        process.stdin.on('end', () => { process.exitCode = 7; });
        process.stdin.resume();
      ` });
      const execution = await runtime.node({ entry: "/workspace/process-cancel.cjs" });
      const reader = execution[channel][Symbol.asyncIterator]();
      // Enter the iterator before return(): returning an unstarted generator need not cancel it.
      const first = await bounded(reader.next(), `${channel} initial bytes`);
      assert(!first.done, `${channel} ended before cancellation`);
      equalBytes(first.value, new Uint8Array([0, 255, 128, 65]));
      assert(reader.return, "Execution channel does not support iterator cancellation");
      const cancelled = await bounded(reader.return(), `${channel} cancellation`);
      assert(cancelled.done === true, "Cancelled iterator did not finish");
      execution.writeStdin(encoder.encode("continue"));
      execution.closeStdin();
      const [bytes, exit] = await bounded(Promise.all([readBytes(execution[other]), execution.exited]),
        "guest continues after channel cancellation");
      equalBytes(bytes, new Uint8Array([0, 128, 255, 66]));
      assert(exit.exitCode === 7 && exit.signal === null && exit.forced === false,
        `Cancellation changed natural exit: ${JSON.stringify(exit)}`);
      assert((await bounded(reader.next(), "cancelled channel remains EOF")).done === true,
        "Cancelled channel yielded later output");
    })],
  })),
  ...(["execution", "runtime"] as const).map((owner): BrowserTest => ({
    name: `${owner} stop cleans child listener and permits port reuse`,
    steps: [() => browserCase(async ({ workspace, runtime }) => {
      await mount(workspace, {
        "/process-parent.cjs": parent,
        "/process-child.cjs": childServer,
        "/process-idle.cjs": "setInterval(() => {}, 1000);",
      });
      const execution = await runtime.node({ entry: "/workspace/process-parent.cjs" });
      const output = capture(execution);
      const sibling = await runtime.node({ entry: "/workspace/process-idle.cjs" });
      const siblingOutput = capture(sibling);
      const endpoint = await runtime.expose(3241, { signal: AbortSignal.timeout(10_000) });
      const response = await bounded(endpoint.fetch("/"), "child listener ready");
      assert(response.status === 200, `Child listener status ${response.status}`);
      equalBytes(new Uint8Array(await bounded(response.arrayBuffer(), "child response")), encoder.encode("child-alive"));
      await bounded(owner === "runtime" ? runtime.stop() : execution.stop(), `${owner} stop`);
      forced((await bounded(output, "parent output EOF")).exit);
      await bounded(endpoint.closed, "child listener closed");
      await rejectsCode(endpoint.fetch("/"), "CLOSED");
      await workspace.fs.writeFile("/process-after-stop.bin", new Uint8Array([0, 255, 128]));
      equalBytes(await workspace.fs.readFile("/process-after-stop.bin"), new Uint8Array([0, 255, 128]));

      let replacementRuntime = runtime;
      if (owner === "runtime") {
        forced((await bounded(siblingOutput, "sibling terminated by runtime stop")).exit);
        await bounded(runtime.stop(), "idempotent runtime stop");
        await rejectsCode(runtime.node({ entry: "/workspace/process-idle.cjs" }), "CLOSED");
        const distribution: Distribution = await (await fetch("/distribution")).json();
        replacementRuntime = await Runtime.start({ workspace, distribution });
      }
      try {
        // A fresh endpoint alone could hide a stale listener. The same port must bind again
        // under a distinct listener identity after the descendant was stopped.
        const replacement = await replacementRuntime.node({ entry: "/workspace/process-child.cjs" });
        const replacementOutput = capture(replacement);
        const next = await replacementRuntime.expose(3241, { signal: AbortSignal.timeout(10_000) });
        assert(next.url !== endpoint.url, "Stopped child listener survived/reused its identity");
        equalBytes(new Uint8Array(await bounded((await bounded(next.fetch("/"), "replacement listener")).arrayBuffer(),
          "replacement response")), encoder.encode("child-alive"));
        await bounded(replacement.stop(), "replacement stop");
        forced((await bounded(replacementOutput, "replacement output EOF")).exit);
        await bounded(next.closed, "replacement listener closed");
        if (owner === "execution") {
          // An unrelated root remains usable after stopping just the parent's subtree.
          sibling.writeStdin(encoder.encode("still-running"));
          await bounded(sibling.stop(), "sibling stop");
          forced((await bounded(siblingOutput, "sibling output EOF")).exit);
        }
      } finally {
        if (replacementRuntime !== runtime) await bounded(replacementRuntime.stop(), "replacement runtime cleanup");
      }
    })],
  })),
];
