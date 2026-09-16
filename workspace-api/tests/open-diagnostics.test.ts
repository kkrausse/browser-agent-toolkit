import { expect, test } from "bun:test";
import { Workspace, opfsStore } from "../src/workspace";
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
  const replacements = [TestWorker, async () => Response.json({ abi: "workspace-v1", version: "qa", kernelWorker: "worker.js", serviceWorker: "sw.js" }), { href: "http://qa.test/" }, true];
  keys.forEach((key, index) => Object.defineProperty(globalThis, key, { configurable: true, value: replacements[index] }));
  try {
    const signal = new AbortController(), events: DiagnosticEvent[] = [];
    const storage = opfsStore({ name: "qa", version: "qa", assetBaseUrl: "/runtime/" });
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
