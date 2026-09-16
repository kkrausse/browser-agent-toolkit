import { expect, test } from "bun:test";
import { createV2SessionReducer } from "../src/vendor/reducer";
import type { SessionMessageInfo, V2Event } from "../src/vendor/types";
test("pinned mixed ordinal identity, ended replacement, independent second text and tool success", () => {
  const reducer = createV2SessionReducer();
  let messages: SessionMessageInfo[] = [];
  let seq = 0;
  const emit = (type: string, data: object) => {
    messages = reducer.reduce(messages, {
      id: `evt_${++seq}`,
      created: seq,
      type,
      data: { sessionID: "s", assistantMessageID: "a", ...data },
    } as V2Event)!.messages;
  };
  emit("session.step.started", {
    agent: "build",
    model: { id: "m", providerID: "p" },
  });
  emit("session.step.streamed", {});
  expect((messages[0] as any).time.streamed).toBe(2);
  emit("session.reasoning.started", { ordinal: 0 });
  emit("session.reasoning.delta", { ordinal: 0, delta: "think" });
  emit("session.tool.input.started", { id: "t", name: "read" });
  emit("session.tool.input.delta", { id: "t", delta: '{"p"' });
  emit("session.tool.input.ended", { id: "t", text: '{"path":"x"}' });
  emit("session.text.started", { ordinal: 0 });
  emit("session.text.delta", { ordinal: 0, delta: "hel" });
  emit("session.text.ended", { ordinal: 0, text: "hello" });
  emit("session.text.started", { ordinal: 1 });
  emit("session.text.delta", { ordinal: 1, delta: "second" });
  emit("session.tool.called", { id: "t", input: { path: "x" } });
  emit("session.tool.success", {
    id: "t",
    content: [{ type: "text", text: "file" }],
    metadata: {},
  });
  const content = (
    messages[0] as Extract<SessionMessageInfo, { type: "assistant" }>
  ).content;
  expect(content.map((p) => p.type)).toEqual([
    "reasoning",
    "tool",
    "text",
    "text",
  ]);
  expect(content[2]).toEqual({ type: "text", text: "hello" });
  expect(content[3]).toEqual({ type: "text", text: "second" });
  expect((content[1] as any).state).toMatchObject({
    status: "completed",
    content: [{ type: "text", text: "file" }],
  });
  emit("session.reasoning.ended", { ordinal: 0, text: "thought" });
  expect((messages[0] as any).content[0].text).toBe("thought");
  expect(
    reducer.reduce([], {
      type: "session.text.delta",
      data: {
        sessionID: "s",
        assistantMessageID: "missing",
        ordinal: 0,
        delta: "x",
      },
    } as V2Event)?.touched,
  ).toEqual([]);
});

test("tool failure and retry survive a step boundary without flattening native content", () => {
  const reducer = createV2SessionReducer();
  let messages: SessionMessageInfo[] = [];
  let seq = 0;
  const emit = (type: string, data: object) => {
    messages = reducer.reduce(messages, {
      id: `evt_${++seq}`,
      created: seq,
      type,
      data: { sessionID: "s", assistantMessageID: "a", ...data },
    } as V2Event)!.messages;
  };
  emit("session.step.started", {
    agent: "build",
    model: { id: "m", providerID: "p" },
  });
  emit("session.tool.input.started", { id: "t", name: "unknown-future-tool" });
  emit("session.tool.called", { id: "t", input: { x: 1 } });
  emit("session.tool.failed", {
    id: "t",
    error: { name: "ToolError", message: "failed" },
    content: [{ type: "text", text: "partial output" }],
    metadata: {},
  });
  emit("session.retry.scheduled", {
    attempt: 2,
    at: 100,
    error: { message: "retry" },
  });
  expect((messages[0] as any).retry.attempt).toBe(2);
  expect((messages[0] as any).content[0].state).toMatchObject({
    status: "error",
    content: [{ type: "text", text: "partial output" }],
  });
  emit("session.step.ended", { finish: "tool-calls", rawFinish: "provider-tool", providerState: { continuation: "opaque" } });
  expect(messages[0]).toMatchObject({ rawFinish: "provider-tool", providerState: { continuation: "opaque" } });
  emit("session.step.started", {
    assistantMessageID: "b",
    agent: "build",
    model: { id: "m", providerID: "p" },
  });
  expect(messages.map((m) => m.id)).toEqual(["a", "b"]);
  expect((messages[0] as any).content[0].name).toBe("unknown-future-tool");
});

test("candidate inbox delivery requests persisted messages instead of inventing message IDs", () => {
  const reducer = createV2SessionReducer();
  const promoted = {
    created: 2,
    type: "session.inbox.delivered",
    data: { sessionID: "s", inboxID: "u" },
  } as V2Event;
  expect(reducer.reduce([], promoted)!.messages).toEqual([]);
  reducer.clear("s");
  expect(reducer.reduce([], promoted)!.missing).toBe("u");
});
