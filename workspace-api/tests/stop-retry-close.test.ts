// Observed failure: one rejected Runtime.stop was replayed forever, so the workspace
// stayed attached, close() never reached its flush, and the document could not reopen.
// Real Workspace/Runtime/SDK launch handling; only the kernel worker is controlled.
import { expect, test } from "bun:test";
import { Runtime } from "../src/runtime";
import { Workspace, opfsStore } from "../src/workspace";

const distribution = { name: "qa", version: "qa", assetBaseUrl: "/runtime/" };
const opened: Workspace[] = [];
const open = async () => { const workspace = await Workspace.open({ id: "default", storage: opfsStore(distribution) }); opened.push(workspace); return workspace; };
type Kernel = { flushes: number; terminated: number; cleanupError?: string; holdKills?: boolean; release(): void };
async function withKernel(run: (kernel: Kernel) => Promise<void>) {
  const keys = ["Worker", "fetch", "location", "crossOriginIsolated"] as const;
  const originals = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const held: (() => void)[] = [];
  const kernel: Kernel = { flushes: 0, terminated: 0, release() { for (const exit of held.splice(0)) exit(); } };
  class TestWorker {
    onmessage?: (event: { data: unknown }) => void;
    private emit(data: unknown) { queueMicrotask(() => this.onmessage?.({ data })); }
    postMessage(message: { type: string; reqId?: number; execId?: number }) {
      if (message.type === "init") return this.emit({ type: "ready" });
      if (message.type === "proc-spawn") return this.emit({ type: "proc-started", execId: message.execId });
      if (message.type === "proc-kill" && kernel.holdKills) return void held.push(() => this.emit({ type: "proc-exit", execId: message.execId, code: 143, signal: "SIGTERM" }));
      if (message.type === "proc-kill") return this.emit({ type: "proc-exit", execId: message.execId, code: 143, signal: "SIGTERM", ...(kernel.cleanupError ? { cleanupError: kernel.cleanupError } : {}) });
      // A graceful close flushes kernel-side as part of `shutdown`; a forced one asks first.
      if (message.type === "workspace-flush" || message.type === "shutdown") kernel.flushes++;
      if (message.reqId !== undefined) this.emit({ type: "vv-reply", reqId: message.reqId, ok: true, persistence: { status: "durable" }, exists: true, isDir: false });
    }
    terminate() { kernel.terminated++; }
  }
  const manifest = { abi: "workspace-v2-sab6-sqlite39", features: ["install-tree-v1", "http-stream-v1", "workspace-flush-v1"], version: "qa", kernelWorker: "worker.js", serviceWorker: "sw.js" };
  const replacements = [TestWorker, async () => Response.json(manifest), { href: "http://qa.test/" }, true];
  keys.forEach((key, index) => Object.defineProperty(globalThis, key, { configurable: true, value: replacements[index] }));
  try { await run(kernel); }
  finally {
    // A failed assertion must not leave the document's single store latched open.
    for (const workspace of opened.splice(0)) await workspace.close({ force: true }).catch(() => {});
    keys.forEach((key, index) => { const descriptor = originals[index]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
  }
}

test("a stop that failed once succeeds on retry, detaching so the workspace closes and reopens", () => withKernel(async kernel => {
  const workspace = await open();
  const runtime = await Runtime.start({ workspace, distribution });
  await runtime.node({ entry: "/fixture.js" });
  kernel.cleanupError = "fixture unlink failed";
  const failed = await runtime.stop().then(() => null, error => error as AggregateError);
  expect(failed?.message).toContain("workspace remains attached");
  expect(failed?.errors.map(String).join()).toContain("fixture unlink failed");
  // The failure is real: nothing detaches, closes or replaces the runtime behind it.
  await expect(workspace.close()).rejects.toMatchObject({ code: "ATTACHED" });
  await expect(Runtime.start({ workspace, distribution })).rejects.toMatchObject({ code: "ATTACHED" });
  expect(kernel.flushes).toBe(0);
  // The process is gone, so its receipt was reported once; the retry has nothing left to join.
  await runtime.stop();
  await runtime.stop();
  await workspace.close();
  expect(kernel).toMatchObject({ flushes: 1, terminated: 1 });
  await (await open()).close();
}));

test("force close flushes, detaches and releases the store, and still reports unproven cleanup", () => withKernel(async kernel => {
  const workspace = await open();
  const runtime = await Runtime.start({ workspace, distribution });
  const execution = await runtime.node({ entry: "/fixture.js" });
  await expect(workspace.close()).rejects.toMatchObject({ code: "ATTACHED" });
  expect(kernel).toMatchObject({ flushes: 0, terminated: 0 });
  await expect(workspace.close({ force: true })).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
  expect(kernel).toMatchObject({ flushes: 1, terminated: 1 });
  expect((await execution.exited).forced).toBe(true);
  await expect(runtime.node({ entry: "/fixture.js" })).rejects.toThrow();
  // Reported once: the workspace is now plainly closed and the document can reopen.
  await workspace.close();
  const reopened = await open();
  await Runtime.start({ workspace: reopened, distribution }).then(next => next.stop());
  await reopened.close();
}));

// Observed gap: force covered a stop that rejects, not one that never settles, so a
// process the kernel never reaped held stop() - and everything awaiting it - forever.
test("a stop that never settles rejects at its deadline, stays retryable, and force then closes", () => withKernel(async kernel => {
  kernel.holdKills = true;
  const workspace = await open();
  const runtime = await Runtime.start({ workspace, distribution, stopTimeoutMs: 20 });
  await runtime.node({ entry: "/fixture.js" });
  const timedOut = { code: "CLEANUP_FAILED", message: expect.stringContaining("1 execution(s)") };
  await expect(runtime.stop()).rejects.toMatchObject(timedOut);
  await expect(workspace.close()).rejects.toMatchObject({ code: "ATTACHED" });
  // Not memoized: the retry joins the same still-registered execution again.
  await expect(runtime.stop()).rejects.toMatchObject(timedOut);
  await expect(workspace.close({ force: true })).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
  expect(kernel).toMatchObject({ flushes: 1, terminated: 1 });

  const reopened = await open();
  const next = await Runtime.start({ workspace: reopened, distribution, stopTimeoutMs: 20 });
  await next.node({ entry: "/fixture.js" });
  await expect(next.stop()).rejects.toMatchObject(timedOut);
  // Once the outstanding process does exit, the retry proves cleanup and detaches.
  kernel.release();
  await next.stop();
  await reopened.close();
}));
