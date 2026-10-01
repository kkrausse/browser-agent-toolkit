import { expect, test } from "bun:test";
import { Workspace, opfsStore } from "../src/workspace";
import { WorkspaceController } from "../src/react";
import type { DiagnosticEvent } from "../src/types";

test("abort after worker ready ends a stalled persistence query, releases the lease, and allows retry", async () => {
  const keys = ["Worker", "fetch", "location", "crossOriginIsolated"] as const;
  const originals = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  let stalled = true, terminated = 0;
  class TestWorker {
    onmessage?: (event: { data: unknown }) => void;
    postMessage(message: { type: string; reqId?: number }) {
      if (message.type === "init") queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } }));
      else if (!(stalled && message.type === "workspace-persistence")) queueMicrotask(() => this.onmessage?.({ data: { type: "vv-reply", reqId: message.reqId, ok: true, persistence: { status: "durable" } } }));
    }
    terminate() { terminated++; }
  }
  const manifest = { abi: "workspace-v2-sab6-sqlite39", features: ["install-tree-v1", "http-stream-v1", "workspace-flush-v1"], version: "qa", kernelWorker: "worker.js", serviceWorker: "sw.js" };
  const replacements = [TestWorker, async () => Response.json(manifest), { href: "http://qa.test/" }, true];
  keys.forEach((key, index) => Object.defineProperty(globalThis, key, { configurable: true, value: replacements[index] }));
  try {
    const signal = new AbortController(), events: DiagnosticEvent[] = [];
    const storage = opfsStore({ name: "qa", version: "qa", assetBaseUrl: "/runtime/" });
    manifest.abi = "workspace-v1";
    await expect(Workspace.open({ id: "default", storage })).rejects.toThrow("Distribution ABI/version/features mismatch");
    expect(terminated).toBe(0);
    manifest.abi = "workspace-v2-sab6-sqlite39";
    manifest.features.pop();
    await expect(Workspace.open({ id: "default", storage })).rejects.toThrow("Distribution ABI/version/features mismatch");
    expect(terminated).toBe(0);
    manifest.features.push("workspace-flush-v1");
    await expect(Workspace.open({ id: "default", storage, signal: signal.signal, onDiagnostic: event => {
      events.push(event);
      if (event.stage === "persistence.query") queueMicrotask(() => signal.abort(new Error("QA persistence deadline")));
    } })).rejects.toThrow("QA persistence deadline");
    expect(terminated).toBe(1);
    expect(events.map(event => event.stage)).toContain("worker.ready");
    expect(events.at(-1)?.detail?.lastStage).toBe("persistence.query");
    expect(events.at(-1)?.elapsedMs).toBeGreaterThanOrEqual(0);
    stalled = false;
    const workspace = await Workspace.open({ id: "default", storage, onDiagnostic: () => { throw Error("observer failure"); } });
    expect(workspace.persistence.status).toBe("durable");
    await workspace.close();
    expect(terminated).toBe(2);
  } finally {
    keys.forEach((key, index) => { const descriptor = originals[index]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
  }
});

// Observed live: a second tab's open failed on the storage owner lock, and the only
// thing the application could show or test was text without STORAGE_BUSY in it.
test("a storage lock timeout reaches the application as STORAGE_BUSY, through the controller too", async () => {
  const keys = ["Worker", "fetch", "location", "crossOriginIsolated"] as const;
  const originals = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  let terminated = 0;
  class OwnedElsewhere {
    onmessage?: (event: { data: unknown }) => void;
    postMessage(message: { type: string }) {
      if (message.type === "init") queueMicrotask(() => this.onmessage?.({ data: { type: "log", line: "kernel worker boot failed: Error: OPFS still owned by another Vivari kernel after 10000ms" } }));
    }
    terminate() { terminated++; }
  }
  const manifest = { abi: "workspace-v2-sab6-sqlite39", features: ["install-tree-v1", "http-stream-v1", "workspace-flush-v1"], version: "qa", kernelWorker: "worker.js", serviceWorker: "sw.js" };
  const replacements = [OwnedElsewhere, async () => Response.json(manifest), { href: "http://qa.test/" }, true];
  keys.forEach((key, index) => Object.defineProperty(globalThis, key, { configurable: true, value: replacements[index] }));
  try {
    const distribution = { name: "qa", version: "qa", assetBaseUrl: "/runtime/" };
    await expect(Workspace.open({ id: "default", storage: opfsStore(distribution) })).rejects.toMatchObject({ name: "WorkspaceError", code: "STORAGE_BUSY" });
    const controller = new WorkspaceController();
    const failed = await controller.open(distribution).then(() => null, error => error);
    expect(failed).toMatchObject({ name: "WorkspaceError", code: "STORAGE_BUSY", lastStage: "worker.log.kernel" });
    expect(failed.message).toContain("Workspace.open (STORAGE_BUSY): kernel worker boot failed");
    expect(failed.cause).toMatchObject({ code: "STORAGE_BUSY" });
    // Recipes run inside run(), which reports rather than throws: the code survives there.
    await controller.run("Open local workspace", async () => { await controller.open(distribution); });
    expect(controller.getSnapshot()).toMatchObject({ errorCode: "STORAGE_BUSY", persistence: "closed" });
    expect(controller.getSnapshot().error).toContain("STORAGE_BUSY");
    expect(terminated).toBe(3);
  } finally {
    keys.forEach((key, index) => { const descriptor = originals[index]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
  }
});
