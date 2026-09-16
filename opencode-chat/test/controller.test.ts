import { afterEach, expect, test } from "bun:test";
import { createChatController } from "../src";
import type { ChatController } from "../src/types";
import { fixture, deferred, json, tick, user, session } from "./fixture";
const controllers: ChatController[] = [];
function start(f = fixture()) {
  const c = createChatController({
    endpoint: f.endpoint,
    directory: "/hidden",
    pageSize: 2,
  });
  controllers.push(c);
  return { f, c };
}
afterEach(() => {
  controllers.splice(0).forEach((c) => c.dispose());
});

test("headless bootstrap uses injected string fetch, marker, requests, immutable stable snapshots and no session mutation", async () => {
  const { f, c } = start();
  await c.ready;
  expect(c.getSnapshot().connection).toBe("connected");
  expect(c.getSnapshot().sessionID).toBe("ses1");
  expect(c.getSnapshot()).toBe(c.getSnapshot());
  expect(Object.isFrozen(c.getSnapshot().sessions)).toBe(true);
  expect(f.calls.every((call) => call.url.host === "injected.invalid")).toBe(
    true,
  );
  expect(f.calls.filter((call) => call.init.method === "POST").map(call => call.url.pathname))
    .toEqual(["/proxy/api/plugin/await-activation"]);
  expect(
    f.calls
      .find((call) => call.url.pathname.endsWith("/session"))!
      .url.searchParams.get("directory"),
  ).toBe("/hidden");
  const before = f.cancels;
  c.dispose();
  await tick();
  expect(f.cancels).toBe(before + 1);
  expect(
    f.calls.some(
      (call) =>
        call.url.pathname.includes("interrupt") ||
        call.url.pathname.includes("stop"),
    ),
  ).toBe(false);
});

test("selection races cannot overwrite newer history", async () => {
  const { f, c } = start();
  await c.ready;
  const pending = deferred<Response>();
  f.override = (url) =>
    url.pathname.endsWith("ses1/message") ? pending.promise : undefined;
  const first = c.selectSession("ses1");
  void first.catch(() => {});
  await tick();
  f.histories.ses2 = [user("msg_second")];
  await c.selectSession("ses2");
  pending.resolve(json({ data: [user("msg_stale")], cursor: {} }));
  await expect(first).rejects.toThrow();
  expect(c.getSnapshot().messages.map((m) => m.id)).toEqual(["msg_second"]);
});

test("selection during bootstrap wins over automatic first selection", async () => {
  const f = fixture(),
    pending = deferred<Response>();
  f.override = (url) =>
    url.pathname.endsWith("/session") ? pending.promise : undefined;
  const { c } = start(f);
  await tick();
  await c.selectSession("ses2");
  pending.resolve(json({ data: [session("ses1")], cursor: {} }));
  await c.ready;
  expect(c.getSnapshot().sessionID).toBe("ses2");
});

test("overlapping history never replays deltas already persisted", async () => {
  const { f, c } = start();
  await c.ready;
  const pending = deferred<Response>();
  f.override = (url) =>
    url.pathname.endsWith("/message") ? pending.promise : undefined;
  const selecting = c.selectSession("ses1");
  await tick();
  f.emit("session.text.delta", {
    sessionID: "ses1",
    assistantMessageID: "msg_a",
    ordinal: 0,
    delta: "hello",
  });
  await tick();
  pending.resolve(
    json({
      data: [
        {
          id: "msg_a",
          type: "assistant",
          content: [{ type: "text", text: "hello" }],
          time: { created: 1 },
          model: { id: "m", providerID: "p" },
          agent: "build",
        },
      ],
      cursor: {},
    }),
  );
  await selecting;
  expect(JSON.stringify(c.getSnapshot().messages)).not.toContain("hellohello");
  expect((c.getSnapshot().messages[0] as any).content[0].text).toBe("hello");
});

test("pending requests hydrate; failed response retains request and can retry pinned payload", async () => {
  const f = fixture();
  f.permissions.push({
    id: "per_r",
    sessionID: "ses1",
    action: "edit",
    resources: ["file"],
  });
  const { c } = start(f);
  await c.ready;
  f.override = (url) =>
    url.pathname.endsWith("/reply") ? json({ error: "no" }, 500) : undefined;
  await expect(c.replyPermission("per_r", "once")).rejects.toThrow("500");
  expect(c.getSnapshot().permissions[0]!.error).toContain("500");
  expect(c.getSnapshot().permissions[0]!.submitting).toBe(false);
  f.override = undefined;
  await c.replyPermission("per_r", "always");
  expect(c.getSnapshot().permissions).toHaveLength(0);
  const call = f.calls.at(-1)!;
  expect(call.url.pathname).toBe("/proxy/api/session/ses1/permission/per_r/reply");
  expect(JSON.parse(String(call.init.body))).toEqual({ reply: "always", message: null });
});

test("question rules and removal answered elsewhere", async () => {
  const f = fixture();
  f.forms.push({
    id: "frm_q",
    sessionID: "ses1",
    title: "Questions", metadata: { kind: "question" },
    fields: [
      {
        key: "q0", type: "string", title: "Pick",
        description: "Which?",
        options: [
          { value: "A", label: "A", description: "a" },
          { value: "B", label: "B", description: "b" },
        ],
        custom: false,
      },
    ],
  });
  const { c } = start(f);
  await c.ready;
  await expect(c.replyQuestion("frm_q", [["C"]])).rejects.toThrow("offered");
  await expect(c.replyQuestion("frm_q", [["A", "B"]])).rejects.toThrow("Choose");
  f.emit("form.replied", {
    sessionID: "ses1",
    id: "frm_q",
    answer: { q0: "A" },
  });
  await tick();
  expect(c.getSnapshot().questions).toHaveLength(0);
  await expect(c.replyQuestion("frm_q", [["A"]])).rejects.toThrow("no longer");
});

test("interrupt failure retains requested and running, HTTP completion alone does not claim stopped", async () => {
  const { f, c } = start();
  await c.ready;
  f.active = { ses1: { type: "running" } };
  f.emit("session.execution.started", { sessionID: "ses1" });
  await tick();
  f.override = (url) =>
    url.pathname.endsWith("/interrupt") ? json({}, 503) : undefined;
  await expect(c.interrupt()).rejects.toThrow("503");
  expect(c.getSnapshot().interruptRequested).toBe(true);
  expect(c.getSnapshot().execution).toBe("running");
  f.override = undefined;
  await c.interrupt();
  expect(c.getSnapshot().execution).toBe("running");
  f.emit("session.execution.interrupted", { sessionID: "ses1", reason: "user" });
  await tick();
  expect(c.getSnapshot().execution).toBe("idle");
  expect(c.getSnapshot().interruptRequested).toBe(false);
});

test("disconnect preserves unknown execution, reconnect hydrates and replaces state", async () => {
  const { f, c } = start();
  await c.ready;
  f.close();
  await tick();
  expect(c.getSnapshot().connection).toBe("disconnected");
  expect(c.getSnapshot().execution).toBe("unknown");
  f.histories.ses1 = [user("msg_after")];
  await c.reconnect();
  expect(c.getSnapshot().messages[0]!.id).toBe("msg_after");
});

test("paged history includes assistant without parent and deduplicates boundaries", async () => {
  const f = fixture();
  f.override = (url) =>
    url.pathname.endsWith("/message")
      ? json(
          url.searchParams.has("cursor")
            ? {
                data: [user("msg_new", undefined, 2), user("msg_old", undefined, 1)],
                cursor: {},
              }
            : { data: [user("msg_new", undefined, 2)], cursor: { next: "cursor" } },
        )
      : undefined;
  const { c } = start(f);
  await c.ready;
  expect(c.getSnapshot().hasOlder).toBe(true);
  await c.loadOlder();
  expect(c.getSnapshot().messages.map((m) => m.id)).toEqual(["msg_old", "msg_new"]);
});

test("disposal during prompt aborts local request, never endpoint or execution", async () => {
  const { f, c } = start();
  await c.ready;
  const wait = deferred<Response>();
  let signal: AbortSignal | undefined;
  f.override = (url, init) => {
    if (url.pathname.endsWith("/prompt")) {
      signal = init.signal!;
      return wait.promise;
    }
  };
  const send = c.send({ text: "hello" });
  void send.catch(() => {});
  await tick();
  c.dispose();
  expect(signal!.aborted).toBe(true);
  wait.resolve(new Response(null, { status: 204 }));
  await expect(send).rejects.toThrow();
  expect(f.calls.some((call) => call.url.pathname.endsWith("/interrupt"))).toBe(
    false,
  );
});

test("request answered during hydration cannot be resurrected by stale HTTP", async () => {
  const f = fixture();
  f.forms.push(questionForm("frm_q"));
  const { c } = start(f);
  await c.ready;
  const pending = deferred<Response>();
  f.override = (url) =>
    url.pathname.endsWith("/message") ? pending.promise : undefined;
  const loading = c.selectSession("ses1");
  await tick();
  f.emit("form.replied", { sessionID: "ses1", id: "frm_q", answer: { q0: "A" } });
  await tick();
  pending.resolve(json({ data: [], cursor: {} }));
  await loading;
  expect(c.getSnapshot().questions).toHaveLength(0);
});

test("question multi/custom replies and reject adapt to candidate form routes", async () => {
  const f = fixture();
  f.forms.push({
    id: "frm_q",
    sessionID: "ses1",
    title: "Questions", metadata: { kind: "question" },
    fields: [
      {
        key: "q0", type: "multiselect", title: "Pick",
        description: "Which?",
        options: [{ value: "A", label: "A", description: "a" }],
        custom: true,
      },
    ],
  });
  const { c } = start(f);
  await c.ready;
  await c.replyQuestion("frm_q", [["A", "custom"]]);
  expect(f.calls.at(-1)!.url.pathname).toBe(
    "/proxy/api/session/ses1/form/frm_q/reply",
  );
  expect(JSON.parse(String(f.calls.at(-1)!.init.body))).toEqual({
    answer: { q0: ["A", "custom"] },
  });
  f.emit("form.created", { form: questionForm("frm_q2") });
  await tick();
  await c.rejectQuestion("frm_q2");
  expect(f.calls.at(-1)!.url.pathname).toBe(
    "/proxy/api/session/ses1/form/frm_q2/cancel",
  );
  expect(f.calls.at(-1)!.init.method).toBe("POST");
  expect(f.calls.at(-1)!.init.body).toBeUndefined();
});

function questionForm(id: string) {
  return { id, sessionID: "ses1", title: "Questions", metadata: { kind: "question" },
    fields: [{ key: "q0", type: "string", title: "Pick", description: "Which?",
      options: [{ value: "A", label: "A" }], custom: true }] };
}

test("unsupported forms remain visible, nested events are scoped, and settled forms disappear", async () => {
  const f = fixture();
  const form = { id: "frm_numeric", sessionID: "ses1", title: "Budget", fields: [{ key: "budget", type: "number" }] };
  f.forms.push(form);
  const { c } = start(f);
  await c.ready;
  expect(c.getSnapshot().unsupportedForms).toEqual([form]);
  await expect(c.replyQuestion("frm_numeric", [["1"]])).rejects.toThrow("no longer");
  f.emit("form.created", { form: { ...questionForm("frm_other"), sessionID: "ses2" } });
  f.emit("form.created", { form: questionForm("frm_ours") });
  f.emit("form.cancelled", { id: "frm_numeric", sessionID: "ses1" });
  await tick();
  expect(c.getSnapshot().questions.map(q => q.request.id)).toEqual(["frm_ours"]);
  expect(c.getSnapshot().unsupportedForms).toEqual([]);
  await c.replyQuestion("frm_ours", [["A"]]);
  expect(JSON.parse(String(f.calls.at(-1)!.init.body))).toEqual({ answer: { q0: "A" } });
  expect(f.calls.some(call => call.url.pathname.includes("/question"))).toBe(false);
});

test("form hydration failure is surfaced rather than treated as no requests", async () => {
  const f = fixture();
  f.override = url => url.pathname.endsWith("/form") ? json({ error: "missing" }, 404) : undefined;
  const { c } = start(f);
  await expect(c.ready).rejects.toThrow("404");
  expect(c.getSnapshot().connection).toBe("disconnected");
  expect(c.getSnapshot().error).toContain("404");
});

test("untitled creation lets the server name sessions and rename events update selected and background chats", async () => {
  const { f, c } = start();
  await c.ready;
  await c.createSession();
  const created = f.calls.find(call => call.url.pathname === "/proxy/api/session" && call.init.method === "POST")!;
  // The official Effect client encodes absent optional fields as null.
  expect(JSON.parse(String(created.init.body))).toMatchObject({ title: null, location: { directory: "/hidden" } });
  f.emit("session.renamed", { sessionID: "ses_new", title: "Generated title" });
  f.emit("session.renamed", { sessionID: "ses1", title: "Background title" });
  await tick();
  expect(c.getSnapshot().sessions.find(s => s.id === "ses_new")?.title).toBe("Generated title");
  expect(c.getSnapshot().sessions.find(s => s.id === "ses1")?.title).toBe("Background title");
});

test("candidate session creation, model selection and inbox prompt acceptance hydrate real messages", async () => {
  const { f, c } = start();
  await c.ready;
  expect(await c.createSession("Candidate chat")).toBe("ses_new");
  const created = f.calls.find(call => call.url.pathname === "/proxy/api/session" && call.init.method === "POST")!;
  expect(JSON.parse(String(created.init.body))).toMatchObject({ title: "Candidate chat", location: { directory: "/hidden" } });
  await c.selectModel({ providerID: "p", id: "m" });
  expect(JSON.parse(String(f.calls.at(-1)!.init.body))).toEqual({ model: { providerID: "p", id: "m" } });
  f.override = (url, init) => {
    if (!url.pathname.endsWith("/prompt")) return;
    expect(JSON.parse(String(init.body))).toMatchObject({ text: "Hello candidate" });
    f.histories.ses_new = [user("msg_actual", "Hello candidate")];
    return json({ data: { id: "msg_inbox_1", sessionID: "ses_new", type: "user", payload: { text: "Hello candidate" }, delivery: "steer", timeCreated: 1 } });
  };
  await c.send({ text: "Hello candidate" });
  expect(c.getSnapshot().messages.map(m => m.id)).toEqual(["msg_actual"]);
  f.histories.ses_new = [user("msg_actual", "Hello candidate"), user("msg_second", "queued", 2)];
  f.emit("session.inbox.delivered", { sessionID: "ses_new", inboxID: "msg_inbox_2" });
  await new Promise(resolve => setTimeout(resolve, 160));
  expect(c.getSnapshot().messages.map(m => m.id)).toEqual(["msg_actual", "msg_second"]);
});

test("controllers remain isolated and disposing one leaves the other subscribed", async () => {
  const one = start(),
    two = start();
  await Promise.all([one.c.ready, two.c.ready]);
  one.c.dispose();
  two.f.emit("session.execution.started", { sessionID: "ses1" });
  await tick();
  expect(two.c.getSnapshot().execution).toBe("running");
  expect(two.f.cancels).toBe(0);
});

test("missing assistant event triggers authoritative recovery", async () => {
  const { f, c } = start();
  await c.ready;
  f.histories.ses1 = [
    {
      id: "msg_missing",
      type: "assistant",
      agent: "build",
      model: { providerID: "p", id: "m" },
      content: [{ type: "text", text: "recovered" }],
      time: { created: 1 },
    },
  ];
  f.emit("session.text.delta", {
    sessionID: "ses1",
    assistantMessageID: "msg_missing",
    ordinal: 0,
    delta: "covered",
  });
  await new Promise((resolve) => setTimeout(resolve, 160));
  expect(c.getSnapshot().messages[0]!.id).toBe("msg_missing");
  expect((c.getSnapshot().messages[0] as any).content[0].text).toBe(
    "recovered",
  );
});

test("accepted prompt followed by refresh failure is not reported as a failed send", async () => {
  const { f, c } = start();
  await c.ready;
  f.override = (url) =>
    url.pathname.endsWith("/message") ? json({}, 503) : undefined;
  await c.send({ text: "accepted" });
  expect(c.getSnapshot().error).toContain("Message accepted; refresh failed");
  expect(c.getSnapshot().execution).toBe("unknown");
  expect(
    f.calls.filter((call) => call.url.pathname.endsWith("/prompt")),
  ).toHaveLength(1);
});

test("Effect handshake timeout closes the subscription before any history work", async () => {
  const f = fixture();
  const released = deferred<void>();
  let signal: AbortSignal | undefined;
  f.override = (url, init) => {
    if (!url.pathname.endsWith("/event")) return;
    signal = init.signal!;
    if (signal.aborted) released.resolve();
    else signal.addEventListener("abort", () => released.resolve(), { once: true });
    return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
  };
  const c = createChatController({ endpoint: f.endpoint, directory: "/workspace", handshakeTimeoutMs: 15 });
  controllers.push(c);
  await expect(c.ready).rejects.toThrow("handshake timed out");
  expect(c.getSnapshot().connection).toBe("disconnected");
  // Timeout may interrupt before a body reader is acquired. The injected fetch
  // signal is the transport contract in both that case and an established SSE.
  await released.promise;
  expect(signal!.aborted).toBe(true);
  expect(f.calls.map(call => call.url.pathname)).toEqual(["/proxy/api/event"]);
});

test("disposing during handshake interrupts readiness and releases the stream", async () => {
  const f = fixture();
  let cancelled = 0;
  f.override = url => url.pathname.endsWith("/event") ? new Response(new ReadableStream({
    cancel() { cancelled++; },
  }), { headers: { "content-type": "text/event-stream" } }) : undefined;
  const { c } = start(f);
  await tick();
  c.dispose();
  await expect(c.ready).rejects.toThrow();
  await tick();
  expect(cancelled).toBe(1);
  expect(f.calls).toHaveLength(1);
});

test("closing a selection cancels its scheduled recovery fiber", async () => {
  const { f, c } = start();
  await c.ready;
  f.emit("session.text.delta", { sessionID: "ses1", assistantMessageID: "msg_missing", ordinal: 0, delta: "late" });
  await tick();
  await c.selectSession("ses2");
  const count = f.calls.length;
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(f.calls).toHaveLength(count);
  expect(c.getSnapshot().sessionID).toBe("ses2");
});

test("official schema rejects incomplete HTTP history rather than publishing it", async () => {
  const f = fixture();
  f.override = url => url.pathname.endsWith("/message")
    ? json({ data: [{ id: "msg_invalid", type: "user", text: "missing timestamp" }], cursor: {} }) : undefined;
  const { c } = start(f);
  await expect(c.ready).rejects.toThrow("SchemaError");
  expect(c.getSnapshot().messages).toEqual([]);
  expect(c.getSnapshot().connection).toBe("disconnected");
});
