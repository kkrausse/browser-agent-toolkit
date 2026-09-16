import { expect, test } from "bun:test";
import { Cause, Effect, ManagedRuntime, Stream } from "effect";
import { OpenCodeAPI } from "../src/api";
import { session } from "./fixture";

test("official SSE decodes split UTF-8/CRLF and multiline data through injected string fetch", async () => {
  const calls: string[] = [];
  const delta = { id: "evt_2", created: 2, type: "session.text.delta", data: {
    sessionID: "ses1", assistantMessageID: "msg_a", ordinal: 0, delta: "é🌱",
  } };
  const bytes = new TextEncoder().encode(
    'data: {"id":"evt_1","created":1,"type":"server.connected",\r\ndata: "data":{}}\r\n\r\n' +
    `data: ${JSON.stringify(delta)}\r\n\r\n`,
  );
  const runtime = ManagedRuntime.make(OpenCodeAPI.layer({
    url: "https://endpoint.test/nested?scope=kept#hash",
    async fetch(input) {
      calls.push(input);
      return new Response(new ReadableStream({ start(c) {
        for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
        c.close();
      } }), { headers: { "content-type": "text/event-stream" } });
    },
  }, "/workspace"));
  try {
    const events = await runtime.runPromise(Effect.gen(function*() {
      return yield* (yield* OpenCodeAPI).events.pipe(Stream.take(2), Stream.runCollect);
    }));
    expect(events.map(e => e.type)).toEqual(["server.connected", "session.text.delta"]);
    expect(JSON.stringify(events[1])).toContain("é🌱");
    expect(calls).toEqual(["https://endpoint.test/nested/api/event?scope=kept"]);
  } finally { await runtime.dispose(); }
});

test("official requests preserve routing queries, encode JSON bytes and carry cancellation", async () => {
  let calls = 0;
  const runtime = ManagedRuntime.make(OpenCodeAPI.layer({
    url: "https://endpoint.test/guest/?route=a&route=b#ignored",
    async fetch(input, init) {
      calls++;
      expect(typeof input).toBe("string");
      const url = new URL(input);
      expect(url.pathname).toBe("/guest/api/session");
      expect(url.searchParams.getAll("route")).toEqual(["a", "b"]);
      expect(url.hash).toBe("");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      expect(await new Response(init?.body).json()).toMatchObject({ title: "New", location: { directory: "/workspace" } });
      return Response.json({ data: session("ses_new") });
    },
  }, "/workspace"));
  try {
    const created = await runtime.runPromise(Effect.gen(function*() { return yield* (yield* OpenCodeAPI).create("New"); }));
    expect(created.time.created).toBe(1);
    expect(calls).toBe(1);
  } finally { await runtime.dispose(); }
});

test("official stream failure envelopes surface instead of reporting a connected chat", async () => {
  const runtime = ManagedRuntime.make(OpenCodeAPI.layer({
    url: "https://endpoint.test",
    async fetch() {
      return new Response('event: effect/httpapi/stream/failure\ndata: {"message":"denied"}\n\n',
        { headers: { "content-type": "text/event-stream" } });
    },
  }, "/workspace"));
  try {
    await expect(runtime.runPromise(Effect.gen(function*() {
      yield* (yield* OpenCodeAPI).events.pipe(Stream.runDrain);
    }).pipe(Effect.catchCause(cause => Effect.fail(new Error(Cause.pretty(cause))))))).rejects.toThrow();
  } finally { await runtime.dispose(); }
});
