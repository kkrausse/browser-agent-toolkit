import { afterEach, expect, test } from "bun:test";
import { createChatController, canSend } from "../src";
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
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((c) => c.dispose()));
});

test("headless bootstrap uses injected string fetch, marker, requests, immutable stable snapshots and no session mutation", async () => {
  const { f, c } = start();
  await c.ready;
  expect(c.getSnapshot().connection).toBe("connected");
  expect(c.getSnapshot().sessionID).toBe("ses1");
  expect(c.getSnapshot().defaultModel).toEqual({ id: "m", providerID: "p" });
  expect(c.getSnapshot().model).toBeUndefined();
  expect(f.calls.find(call => call.url.pathname.endsWith("/model/default"))?.url.searchParams.get("location[directory]")).toBe("/hidden");
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

test("fresh startup creates an empty session without hydrating old history or deleting sessions", async () => {
  const f = fixture();
  const c = createChatController({ endpoint: f.endpoint, directory: "/workspace", startNewSession: true });
  controllers.push(c);
  await c.ready;
  const state = c.getSnapshot();
  expect(state.sessionID).toBeDefined();
  expect(state.sessionID).not.toBe("ses1");
  expect(state.sessions.some(session => session.id === "ses1")).toBe(true);
  expect(state.messages).toEqual([]);
  expect(state.execution).toBe("idle");
  expect(f.calls.some(call => call.url.pathname.endsWith("/ses1/message"))).toBe(false);
  expect(f.calls.filter(call => call.init.method === "DELETE")).toHaveLength(0);
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

test("selected session automatically drains paged history and deduplicates boundaries", async () => {
  const f = fixture();
  let rejectedIllegalCursorQueries = 0;
  f.override = (url) => {
    if (!url.pathname.endsWith("/message")) return;
    if (url.searchParams.has("cursor") && url.searchParams.has("order")) {
      rejectedIllegalCursorQueries++;
      return json({ _tag: "InvalidCursorError", message: "Cursor cannot be combined with order" }, 400);
    }
    return json(
          url.searchParams.get("cursor") === "second"
            ? {
                data: [user("msg_oldest", undefined, 0)],
                cursor: {},
              }
            : url.searchParams.has("cursor")
            ? {
                data: [user("msg_new", undefined, 2), user("msg_old", undefined, 1)],
                cursor: { next: "second" },
              }
            : { data: [user("msg_new", undefined, 2)], cursor: { next: "cursor" } },
        );
  };
  const { c } = start(f);
  await c.ready;
  expect(c.getSnapshot().hasOlder).toBe(false);
  expect(c.getSnapshot().loadingOlder).toBe(false);
  expect(c.getSnapshot().messages.map((m) => m.id)).toEqual(["msg_oldest", "msg_old", "msg_new"]);
  const calls = f.calls.filter(call => call.url.pathname.endsWith("/message"));
  expect(calls).toHaveLength(3);
  expect(rejectedIllegalCursorQueries).toBe(0);
  expect(calls[0]!.url.searchParams.get("order")).toBe("desc");
  expect(calls.slice(1).every(call => !call.url.searchParams.has("order"))).toBe(true);
  expect(calls.every(call => call.url.searchParams.get("limit") === "2")).toBe(true);
});

test("automatic history drain stops repeated cursors and retains loaded messages with an error", async () => {
  const f = fixture();
  f.override = url => url.pathname.endsWith("/message")
    ? url.searchParams.get("cursor") === "first"
      ? json({ data: [user("msg_old", undefined, 1)], cursor: { next: "second" } })
      : url.searchParams.get("cursor") === "second"
        ? json({ data: [user("msg_older", undefined, 0)], cursor: { next: "first" } })
        : json({ data: [user("msg_new", undefined, 2)], cursor: { next: "first" } })
    : undefined;
  const { c } = start(f);
  await expect(c.ready).rejects.toThrow("Repeated history cursor");
  expect(c.getSnapshot().messages.map(message => message.id)).toEqual(["msg_old", "msg_new"]);
  expect(c.getSnapshot().loadingOlder).toBe(false);
  expect(c.getSnapshot().hasOlder).toBe(false);
  expect(c.getSnapshot().error).toContain("Repeated history cursor");
  expect(f.calls.filter(call => call.url.pathname.endsWith("/message"))).toHaveLength(3);
});

test("session switch cancels an automatic history drain without stale prepends", async () => {
  const { f, c } = start();
  await c.ready;
  const pending = deferred<Response>();
  f.override = url => {
    if (!url.pathname.endsWith("/message")) return;
    const id = url.pathname.split("/").at(-2)!;
    if (id === "ses1")
      return url.searchParams.has("cursor")
        ? pending.promise
        : json({ data: [user("msg_first")], cursor: { next: "older" } });
    return json({ data: [user("msg_second")], cursor: {} });
  };
  const first = c.selectSession("ses1");
  void first.catch(() => {});
  await tick();
  await c.selectSession("ses2");
  pending.resolve(json({ data: [user("msg_stale")], cursor: {} }));
  await expect(first).rejects.toThrow();
  expect(c.getSnapshot().sessionID).toBe("ses2");
  expect(c.getSnapshot().messages.map(message => message.id)).toEqual(["msg_second"]);
  expect(c.getSnapshot().loadingOlder).toBe(false);
});

test("chat export includes paged primary and subagent sessions with oldest-first deduplicated histories", async () => {
  const f = fixture();
  let rejectedIllegalCursorQueries = 0;
  const primary = { ...session("ses_primary", "Primary"), time: { created: 20, updated: 20 } };
  const subagent = { ...session("ses_sub", "Subagent"), parentID: "ses_primary", time: { created: 10, updated: 10 } };
  f.override = (url, init) => {
    if (url.searchParams.has("cursor") && url.searchParams.has("order")) {
      rejectedIllegalCursorQueries++;
      return json({ _tag: "InvalidCursorError", message: "Cursor cannot be combined with order" }, 400);
    }
    if (url.pathname.endsWith("/session") && (!init.method || init.method === "GET"))
      return url.searchParams.get("cursor") === "sessions-2"
        ? json({ data: [primary, subagent], cursor: {} })
        : json({ data: [primary], cursor: { next: "sessions-2" } });
    if (!url.pathname.endsWith("/message")) return;
    const id = url.pathname.split("/").at(-2)!;
    const cursor = url.searchParams.get("cursor");
    if (id === "ses_primary")
      return cursor === "primary-2"
        ? json({ data: [user("msg_middle", "boundary", 2), user("msg_old", "old", 1)], cursor: {} })
        : json({ data: [user("msg_new", "new", 3), user("msg_middle", "newest copy", 2)], cursor: { next: "primary-2" } });
    return json({ data: [user("msg_sub", "sub", 4)], cursor: {} });
  };
  const { c } = start(f);
  await c.ready;
  const selected = c.getSnapshot().sessionID;
  const snapshot = c.getSnapshot();
  const callsBeforeExport = f.calls.length;
  const archive = await c.exportChats();
  expect(archive).toEqual({
    format: "opencode-chat",
    version: 1,
    portability: { resume: "unsupported", attachmentBytes: "not-included" },
    sessions: [
      { session: subagent, messages: [user("msg_sub", "sub", 4)] },
      { session: primary, messages: [
        user("msg_old", "old", 1),
        user("msg_middle", "newest copy", 2),
        user("msg_new", "new", 3),
      ] },
    ],
  });
  expect(c.getSnapshot()).toBe(snapshot);
  expect(c.getSnapshot().sessionID).toBe(selected);
  expect(rejectedIllegalCursorQueries).toBe(0);
  const exportCalls = f.calls.slice(callsBeforeExport);
  const sessionPages = exportCalls.filter(call => call.url.pathname.endsWith("/session"));
  const messagePages = exportCalls.filter(call => call.url.pathname.endsWith("/message"));
  expect(sessionPages.filter(call => call.url.searchParams.has("cursor"))).not.toHaveLength(0);
  expect(sessionPages.filter(call => call.url.searchParams.has("cursor"))
    .every(call => !call.url.searchParams.has("order"))).toBe(true);
  expect(messagePages.filter(call => call.url.searchParams.has("cursor"))
    .every(call => !call.url.searchParams.has("order"))).toBe(true);
  expect(messagePages.every(call => call.url.searchParams.get("limit") === "2")).toBe(true);
});

test("chat export rejects repeated message cursors without publishing UI state", async () => {
  const { f, c } = start();
  await c.ready;
  f.override = url => url.pathname.endsWith("/message")
    ? json({ data: [], cursor: { next: "same" } }) : undefined;
  const snapshot = c.getSnapshot();
  await expect(c.exportChats()).rejects.toThrow("Repeated export history cursor for session");
  expect(c.getSnapshot()).toBe(snapshot);
});

test("chat export propagates page failures without changing selection", async () => {
  const { f, c } = start();
  await c.ready;
  const selected = c.getSnapshot().sessionID;
  f.override = url => url.pathname.endsWith("/message")
    ? url.searchParams.has("cursor")
      ? json({ error: "page failed" }, 503)
      : json({ data: [], cursor: { next: "next" } })
    : undefined;
  await expect(c.exportChats()).rejects.toThrow("503");
  expect(c.getSnapshot().sessionID).toBe(selected);
  expect(c.getSnapshot().error).toBeUndefined();
});

test("disposing cancels an in-flight chat export", async () => {
  const { f, c } = start();
  await c.ready;
  const wait = deferred<Response>();
  let signal: AbortSignal | undefined;
  f.override = (url, init) => {
    if (url.pathname.endsWith("/session")) {
      signal = init.signal!;
      return wait.promise;
    }
  };
  const exporting = c.exportChats();
  void exporting.catch(() => {});
  await tick();
  c.dispose();
  expect(signal!.aborted).toBe(true);
  wait.resolve(json({ data: [], cursor: {} }));
  await expect(exporting).rejects.toThrow();
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

test("model selection waits for server acceptance and survives session switches and reconnect", async () => {
  const f = fixture();
  const accepted = deferred<Response>();
  const selected = { providerID: "p", id: "m" };
  let persisted = false;
  f.override = (url, init) => {
    if (url.pathname === "/proxy/api/session/ses1/model") {
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({ model: selected });
      return accepted.promise.then(response => { persisted = true; return response; });
    }
    if (persisted && url.pathname === "/proxy/api/session") return json({
      data: [{ ...session("ses1"), model: selected }, session("ses2")], cursor: {},
    });
  };
  const { c } = start(f);
  await c.ready;
  const selecting = c.selectModel(selected);
  await tick();
  expect(c.getSnapshot().model).toBeUndefined();
  accepted.resolve(new Response(null, { status: 204 }));
  await selecting;
  expect(persisted).toBe(true);
  expect(c.getSnapshot().model).toEqual(selected);
  await c.selectSession("ses2");
  await c.selectSession("ses1");
  expect(c.getSnapshot().model).toEqual(selected);
  await c.reconnect();
  expect(c.getSnapshot().model).toEqual(selected);
  expect(f.calls.some(call => /\/(credential|integration|provider)(\/|$)/.test(call.url.pathname))).toBe(false);
});

test("rejected model selection leaves the resolved server default and session model unchanged", async () => {
  const { f, c } = start();
  await c.ready;
  f.override = url => url.pathname.endsWith("/ses1/model") ? json({ error: "rejected" }, 409) : undefined;
  await expect(c.selectModel({ providerID: "p", id: "m" })).rejects.toThrow("409");
  expect(c.getSnapshot().model).toBeUndefined();
  expect(c.getSnapshot().defaultModel).toEqual({ providerID: "p", id: "m" });
  expect(c.getSnapshot().sessions.find(item => item.id === "ses1")?.model).toBeUndefined();
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

const posted = (f: ReturnType<typeof fixture>, suffix: string) =>
  f.calls.filter(call => call.init.method === "POST" && call.url.pathname.endsWith(suffix));

test("a held chat rejects send, session and model changes without posting; release restores them", async () => {
  const { f, c } = start();
  await c.ready;
  const hold = c.hold("Saving workspace");
  expect(c.getSnapshot().held).toBe("Saving workspace");
  expect(canSend(c.getSnapshot())).toBe(false);
  await expect(c.send({ text: "hello" })).rejects.toThrow("Chat is held: Saving workspace");
  await expect(c.createSession()).rejects.toThrow("Chat is held");
  await expect(c.selectSession("ses2")).rejects.toThrow("Chat is held");
  await expect(c.selectModel({ providerID: "p", id: "m" })).rejects.toThrow("Chat is held");
  await expect(c.reconnect()).rejects.toThrow("Chat is held");
  expect(() => c.hold("second")).toThrow("already held");
  expect(f.calls.filter(call => call.init.method === "POST" && !call.url.pathname.endsWith("/await-activation"))).toEqual([]);
  expect(c.getSnapshot().sessionID).toBe("ses1");
  expect(c.getSnapshot().sessionOperationPending).toBe(false);
  hold.release();
  hold.release();
  expect(c.getSnapshot().held).toBeUndefined();
  await c.send({ text: "hello" });
  expect(posted(f, "/prompt")).toHaveLength(1);
});

test("a send admitted just before a hold either blocks the hold or is never posted", async () => {
  const { f, c } = start();
  await c.ready;
  const sent = c.send({ text: "hello" });
  void sent.catch(() => {});
  let hold: ReturnType<ChatController["hold"]> | undefined;
  try { hold = c.hold("Switching workspace"); } catch { /* the send won admission */ }
  await sent.catch(() => {});
  expect(posted(f, "/prompt")).toHaveLength(hold ? 0 : 1);
});

test("hold cannot be acquired while executing, sending, or with a pending operation or request", async () => {
  const f = fixture();
  const { c } = start(f);
  expect(() => c.hold("early")).toThrow("connecting");
  await c.ready;
  f.emit("session.execution.started", { sessionID: "ses1" });
  await tick();
  expect(() => c.hold("switch")).toThrow("execution is running");
  f.emit("session.execution.succeeded", { sessionID: "ses1" });
  await tick();
  f.emit("permission.asked", { id: "per_1", sessionID: "ses1", action: "edit", resources: ["file"] });
  await tick();
  expect(() => c.hold("switch")).toThrow("permission request is pending");
  f.emit("permission.replied", { sessionID: "ses1", requestID: "per_1", reply: "once" });
  await tick();
  const creating = deferred<Response>();
  f.override = (url, init) => url.pathname.endsWith("/session") && init.method === "POST" ? creating.promise : undefined;
  const created = c.createSession();
  expect(c.getSnapshot().sessionOperationPending).toBe(true);
  expect(() => c.hold("switch")).toThrow("cannot be held");
  creating.resolve(json({ data: session("ses_new", "New") }));
  await created;
  const prompt = deferred<Response>();
  f.override = url => url.pathname.endsWith("/prompt") ? prompt.promise : undefined;
  const sent = c.send({ text: "hello" });
  await tick();
  expect(() => c.hold("switch")).toThrow("message is being sent");
  prompt.resolve(json({ data: { id: "msg_inbox", sessionID: "ses_new", type: "user", payload: { text: "hello" }, delivery: "steer", timeCreated: 1 } }));
  await sent;
  expect(c.getSnapshot().held).toBeUndefined();
  c.hold("switch").release();
});

test("an unsupported form can be dismissed, cancelling it so the chat can be held again", async () => {
  const f = fixture();
  f.forms.push({ id: "frm_numeric", sessionID: "ses1", title: "Budget", fields: [{ key: "budget", type: "number" }] });
  const { c } = start(f);
  await c.ready;
  expect(() => c.hold("switch")).toThrow("question is pending");
  f.override = url => url.pathname.endsWith("/cancel") ? json({}, 503) : undefined;
  await expect(c.dismissForm("frm_numeric")).rejects.toThrow("503");
  expect(c.getSnapshot().unsupportedForms).toHaveLength(1);
  f.override = undefined;
  await c.dismissForm("frm_numeric");
  expect(f.calls.at(-1)!.url.pathname).toBe("/proxy/api/session/ses1/form/frm_numeric/cancel");
  expect(c.getSnapshot().unsupportedForms).toEqual([]);
  await expect(c.dismissForm("frm_numeric")).rejects.toThrow("no longer pending");
  c.hold("switch").release();
});

test("a history refresh during a streamed answer never shrinks the text or reloads earlier messages", async () => {
  const f = fixture();
  const assistant = (text: string, completed?: number) => ({
    id: "msg_a", type: "assistant", agent: "build", model: { providerID: "p", id: "m" },
    content: [{ type: "text", text }], time: { created: 2, ...(completed ? { completed } : {}) },
  });
  // Like the server: every non-empty page carries a cursor, and deltas are not
  // persisted, so a streaming part reads as empty until its text ends.
  let persisted: unknown[] = [user("msg_u", "essay please")];
  let page: Promise<Response> | undefined;
  f.override = url => !url.pathname.endsWith("/message") ? undefined
    : url.searchParams.has("cursor") ? json({ data: [], cursor: {} })
    : page ?? json({ data: [...persisted].reverse(), cursor: { next: "older" } });
  const { c } = start(f);
  await c.ready;
  const lengths: number[] = [];
  let reloads = 0;
  c.subscribe(() => {
    const state = c.getSnapshot(), message = state.messages.find(m => m.id === "msg_a");
    if (message?.type === "assistant" && message.content[0]?.type === "text") lengths.push(message.content[0].text.length);
    if (state.loadingOlder) reloads++;
  });
  const cursorCalls = () => f.calls.filter(call => call.url.pathname.endsWith("/message") && call.url.searchParams.has("cursor")).length;
  const drained = cursorCalls();
  const ids = { sessionID: "ses1", assistantMessageID: "msg_a" };
  const text = () => (c.getSnapshot().messages.find(m => m.id === "msg_a") as any)?.content[0]?.text;
  f.active = { ses1: { type: "running" } };
  f.emit("session.execution.started", { sessionID: "ses1" });
  f.emit("session.step.started", { ...ids, agent: "build", model: { providerID: "p", id: "m" } });
  f.emit("session.text.started", { ...ids, ordinal: 0 });
  f.emit("session.text.delta", { ...ids, ordinal: 0, delta: "The sky " });
  await tick();
  expect(text()).toBe("The sky ");
  // A refresh starts mid-stream and is slow, as in the browser kernel.
  persisted = [user("msg_u", "essay please"), assistant("")];
  const slow = deferred<Response>();
  page = slow.promise;
  f.emit("session.inbox.delivered", { sessionID: "ses1", inboxID: "msg_inbox" });
  await new Promise(resolve => setTimeout(resolve, 160));
  f.emit("session.text.delta", { ...ids, ordinal: 0, delta: "is blue " });
  await tick();
  expect(text()).toBe("The sky is blue ");
  page = undefined;
  slow.resolve(json({ data: [...persisted].reverse(), cursor: { next: "older" } }));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(c.getSnapshot().messages.map(m => m.id)).toEqual(["msg_u", "msg_a"]);
  expect(text()).toBe("The sky is blue ");
  f.emit("session.text.delta", { ...ids, ordinal: 0, delta: "because" });
  await tick();
  // A fast refresh between two deltas reads the same empty persisted part.
  f.emit("session.inbox.delivered", { sessionID: "ses1", inboxID: "msg_inbox_2" });
  await new Promise(resolve => setTimeout(resolve, 160));
  expect(text()).toBe("The sky is blue because");
  f.emit("session.text.delta", { ...ids, ordinal: 0, delta: " of scattering." });
  await tick();
  expect(text()).toBe("The sky is blue because of scattering.");
  expect(lengths.every((length, i) => i === 0 || length >= lengths[i - 1]!)).toBe(true);
  expect(reloads).toBe(0);
  expect(cursorCalls()).toBe(drained);
  expect(c.getSnapshot().execution).toBe("running");
});

test("a finished run reads idle only once its final history is in the transcript", async () => {
  const { f, c } = start();
  await c.ready;
  f.active = { ses1: { type: "running" } };
  f.emit("session.execution.started", { sessionID: "ses1" });
  await tick();
  const slow = deferred<Response>();
  f.override = url => url.pathname.endsWith("/message") ? slow.promise : undefined;
  f.active = {};
  f.emit("session.execution.succeeded", { sessionID: "ses1" });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(c.getSnapshot().execution).toBe("running");
  expect(canSend(c.getSnapshot())).toBe(false);
  const idleWith: number[] = [];
  c.subscribe(() => { if (c.getSnapshot().execution === "idle") idleWith.push(c.getSnapshot().messages.length); });
  slow.resolve(json({ data: [user("msg_answer", "final", 2), user("msg_u", "question", 1)], cursor: {} }));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(c.getSnapshot().execution).toBe("idle");
  expect(idleWith[0]).toBe(2);
  // The event is authoritative: a failed refresh reports its error and still ends the run.
  f.emit("session.execution.started", { sessionID: "ses1" });
  await tick();
  f.override = url => url.pathname.endsWith("/message") ? json({}, 503) : undefined;
  f.emit("session.execution.interrupted", { sessionID: "ses1", reason: "user" });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(c.getSnapshot().execution).toBe("idle");
  expect(c.getSnapshot().error).toContain("503");
});

test("New chat returns to the unsent session it already created instead of creating another", async () => {
  const { f, c } = start();
  await c.ready;
  const created = () => posted(f, "/session").length;
  expect(await c.createSession()).toBe("ses_new");
  expect(await c.createSession()).toBe("ses_new");
  await c.selectSession("ses1");
  expect(await c.createSession()).toBe("ses_new");
  expect(c.getSnapshot().sessionID).toBe("ses_new");
  expect(canSend(c.getSnapshot())).toBe(true);
  expect(created()).toBe(1);
  expect(c.getSnapshot().sessions.filter(item => item.id === "ses_new")).toHaveLength(1);
  // Once something was sent to it, New chat creates again.
  await c.send({ text: "hello" });
  await c.createSession();
  expect(created()).toBe(2);
});
