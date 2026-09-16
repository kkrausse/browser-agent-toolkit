import { describe, expect, test } from "bun:test";
import { attachChat, chatFor, editorLifecycle } from "../src/editor-adapter";
import type { Service, WorkspaceController } from "@kev-browser-agent-kit/workspace/react";
import { fixture as chatFixture } from "./fixture";

const deferred = <T = void>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
describe("mounted editor lifecycle", () => {
  const owner = () => {
    const calls: string[] = [];
    const controller = {
      cancelAndClose: async () => { calls.push("close"); },
      run: async (_label: string, task: () => Promise<void>) => { await task(); },
      reportError: (error: unknown) => { calls.push(String(error)); },
    } as unknown as WorkspaceController;
    return { controller, calls, start: async () => { calls.push("start"); } };
  };
  test("StrictMode replay admits one start and closes only the admitted mount", async () => {
    const f = owner();
    editorLifecycle(f.controller, f.start)();
    const cleanup = editorLifecycle(f.controller, f.start);
    await tick(); expect(f.calls).toEqual(["close", "start"]);
    cleanup(); await tick(); expect(f.calls).toEqual(["close", "start", "close"]);
  });
  test("remount waits for the previous host cleanup before restarting", async () => {
    const f = owner(), gate = deferred();
    const cleanup = editorLifecycle(f.controller, f.start, () => gate.promise);
    await tick(); cleanup();
    const cleanupNext = editorLifecycle(f.controller, f.start);
    await tick(); expect(f.calls).toEqual(["close", "start"]);
    gate.resolve(); await tick();
    expect(f.calls).toEqual(["close", "start", "close", "close", "start"]);
    cleanupNext(); await tick();
  });
  test("startup is cancelled while initial close is pending", async () => {
    const f = owner(), gate = deferred();
    f.controller.cancelAndClose = () => gate.promise;
    const cleanup = editorLifecycle(f.controller, f.start);
    await tick(); cleanup(); gate.resolve(); await tick();
    expect(f.calls).toEqual([]);
  });
});

test("chat attachment is shared per service, uses its transport, and abort disposes it", async () => {
  const f = chatFixture(), lifetime = new AbortController();
  let release = () => {}, disposed = false;
  const ready: string[] = [];
  const owner = {
    signal: lifetime.signal,
    registerAttachment: (_name: string, dispose: () => void) => {
      release = () => { if (!disposed) { disposed = true; dispose(); } };
      return release;
    },
    clientReady: (name: string) => { ready.push(name); },
    clientFailed: () => {},
  } as unknown as WorkspaceController;
  const service = { connection: f.endpoint } as unknown as Service;
  const [one, two] = await Promise.all([
    attachChat(owner, service, { serviceName: "agent", directory: "/project" }),
    attachChat(owner, service, { serviceName: "agent", directory: "/project" }),
  ]);
  expect(one).toBe(two); expect(chatFor(service)).toBe(one);
  expect(ready).toEqual(["agent", "agent"]);
  expect(f.calls.filter(call => call.url.pathname.endsWith("/session"))).toHaveLength(1);
  expect(f.calls.find(call => call.url.pathname.endsWith("/session"))!.url.searchParams.get("directory")).toBe("/project");
  const cancels = f.cancels;
  lifetime.abort(); release(); await tick();
  expect(chatFor(service)).toBeUndefined();
  expect(f.cancels).toBe(cancels + 1);
});
