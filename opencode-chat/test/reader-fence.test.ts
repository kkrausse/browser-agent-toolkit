import { expect, test } from "bun:test";
import { createChatController } from "../src/controller";
import { createReaderFence } from "../src/reader-fence";
import { deferred, fixture } from "./fixture";

test("disposal joins delayed SSE cancellation, freezes admission and is idempotent", async () => {
  const f = fixture();
  const cancelling = deferred<void>(), release = deferred<void>();
  f.override = url => url.pathname.endsWith("/event") ? new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"id":"evt_1","created":1,"type":"server.connected","data":{}}\r\n\r\n'));
    },
    cancel() { cancelling.resolve(); return release.promise; },
  }), { headers: { "content-type": "text/event-stream" } }) : undefined;
  const c = createChatController({ endpoint: f.endpoint, directory: "/workspace" });
  await c.ready;
  let complete = false;
  const completion = c.dispose();
  void completion.then(() => { complete = true; });
  expect(c.dispose()).toBe(completion);
  await cancelling.promise;
  expect(complete).toBe(false);
  const calls = f.calls.length;
  await expect(c.createSession()).rejects.toThrow("disposed");
  expect(() => c.exportChats()).toThrow("disposed");
  expect(f.calls.length).toBe(calls);
  release.resolve();
  await completion;
  expect(complete).toBe(true);
  expect(f.calls.some(call => call.url.pathname.endsWith("/interrupt"))).toBe(false);
});

for (const kind of ["history", "archive", "permission", "form", "accepted-refresh"] as const) {
  test(`disposal waits for delayed ${kind} transport settlement and late body cleanup`, async () => {
    const f = fixture();
    f.permissions.push({ id: "per_1", sessionID: "ses1", action: "edit", resources: [] });
    f.forms.push({ id: "frm_1", sessionID: "ses1", title: "Pick", metadata: { kind: "question" },
      fields: [{ key: "q0", type: "string", title: "Pick", options: [{ value: "A", label: "A" }] }] });
    const c = createChatController({ endpoint: f.endpoint, directory: "/workspace" });
    await c.ready;
    const entered = deferred<void>(), pending = deferred<Response>();
    const cancelling = deferred<void>(), release = deferred<void>();
    let signal: AbortSignal | null | undefined;
    f.override = (url, init) => {
      const match = kind === "permission" || kind === "form"
        ? url.pathname.endsWith("/reply") : url.pathname.endsWith("/message");
      if (!match) return;
      signal = init.signal;
      entered.resolve();
      return pending.promise;
    };
    const operation = kind === "history" ? c.selectSession("ses1") : kind === "archive" ? c.exportChats()
      : kind === "permission" ? c.replyPermission("per_1", "once")
      : kind === "form" ? c.replyQuestion("frm_1", [["A"]]) : c.send({ text: "fixture-only acceptance" });
    // Never inference: every request is handled by the injected fixture.
    void operation.catch(() => {});
    await entered.promise;
    const snapshot = c.getSnapshot();
    let complete = false;
    const completion = c.dispose();
    void completion.then(() => { complete = true; });
    await operation.catch(() => {});
    expect(signal?.aborted).toBe(true);
    expect(complete).toBe(false);
    pending.resolve(new Response(new ReadableStream({
      cancel() { cancelling.resolve(); return release.promise; },
    })));
    await cancelling.promise;
    expect(complete).toBe(false);
    expect(c.getSnapshot()).toBe(snapshot);
    release.resolve();
    await completion;
    expect(complete).toBe(true);
    expect(c.getSnapshot()).toBe(snapshot);
  });
}

test("unresolved cleanup prevents the caller from evicting or acquiring a replacement", async () => {
  const release = deferred<void>(), cancelling = deferred<void>();
  const fence = createReaderFence({ url: "https://fixture.invalid", fetch: async () => new Response(new ReadableStream({
    cancel() { cancelling.resolve(); return release.promise; },
  })) });
  await fence.endpoint.fetch("https://fixture.invalid");
  const operations: string[] = [];
  const switchBoundary = fence.close().then(() => { operations.push("evict", "acquire"); });
  await cancelling.promise;
  expect(operations).toEqual([]);
  await expect(fence.endpoint.fetch("https://fixture.invalid")).rejects.toThrow("disposed");
  release.resolve();
  await switchBoundary;
  expect(operations).toEqual(["evict", "acquire"]);
});

test("failed reader finalization rejects cached cleanup and never admits replacement", async () => {
  const fence = createReaderFence({ url: "https://fixture.invalid", fetch: async () => new Response(new ReadableStream({
    cancel() { return Promise.reject(new Error("controlled cleanup failure")); },
  })) });
  await fence.endpoint.fetch("https://fixture.invalid");
  const operations: string[] = [];
  const completion = fence.close();
  expect(fence.close()).toBe(completion);
  await expect(completion.then(() => { operations.push("evict", "acquire"); })).rejects.toThrow("cleanup failed");
  expect(operations).toEqual([]);
  await expect(fence.endpoint.fetch("https://fixture.invalid")).rejects.toThrow("disposed");
});

test("body consumption and cancellation are joined even after fetch resolves", async () => {
  const pulling = deferred<void>(), cancelling = deferred<void>(), release = deferred<void>();
  const fence = createReaderFence({ url: "https://fixture.invalid", fetch: async () => new Response(new ReadableStream({
    pull() { pulling.resolve(); },
    cancel() { cancelling.resolve(); return release.promise; },
  })) });
  const response = await fence.endpoint.fetch("https://fixture.invalid");
  const reading = response.text();
  await pulling.promise;
  let complete = false;
  const completion = fence.close().then(() => { complete = true; });
  await cancelling.promise;
  expect(complete).toBe(false);
  release.resolve();
  await Promise.all([completion, reading]);
  expect(complete).toBe(true);
});

test("local reader completion is not a remote location-reference or tool-finalizer receipt", async () => {
  const remoteRelease = deferred<void>();
  let remoteFinalized = false;
  const remoteWork = remoteRelease.promise.then(() => { remoteFinalized = true; });
  const fence = createReaderFence({ url: "https://fixture.invalid", fetch: async () => new Response(new ReadableStream({
    // A local transport cancellation acknowledgement can precede remote cleanup.
    cancel() {},
  })) });
  await fence.endpoint.fetch("https://fixture.invalid");
  await fence.close();
  expect(remoteFinalized).toBe(false);
  // No eviction/acquisition is authorized by this local-only receipt.
  remoteRelease.resolve();
  await remoteWork;
  expect(remoteFinalized).toBe(true);
});

test("controller disposal exposes transport finalizer failure to an awaiting switch owner", async () => {
  const f = fixture();
  f.override = url => url.pathname.endsWith("/event") ? new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"id":"evt_1","created":1,"type":"server.connected","data":{}}\r\n\r\n'));
    },
    cancel() { return Promise.reject(new Error("controlled SSE cleanup failure")); },
  }), { headers: { "content-type": "text/event-stream" } }) : undefined;
  const c = createChatController({ endpoint: f.endpoint, directory: "/workspace" });
  await c.ready;
  const completion = c.dispose();
  expect(c.dispose()).toBe(completion);
  await expect(completion).rejects.toThrow("cleanup failed");
  await expect(c.reconnect()).rejects.toThrow("disposed");
});
