import type { ChatEndpoint, SessionMessageInfo, SessionInfo } from "../src/types";
export const session = (id: string, title = id): SessionInfo => ({
  id, title, projectID: "project", location: { directory: "/hidden" },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});
export const location = { directory: "/hidden", project: { id: "project", directory: "/hidden", canonical: "/hidden" } };
export const model = { id: "m", modelID: "m", providerID: "p", name: "Model", enabled: true,
  capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [],
  time: { released: 1 }, cost: [], status: "active", limit: { context: 1000, output: 100 } };
export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
export const user = (id: string, text = id, time = 1): SessionMessageInfo => ({
  id,
  type: "user",
  text,
  time: { created: time },
});
export function fixture() {
  let stream: ReadableStreamDefaultController<Uint8Array>;
  let seq = 0,
    cancels = 0;
  const calls: { url: URL; init: RequestInit }[] = [];
  const histories: Record<string, SessionMessageInfo[]> = { ses1: [], ses2: [] };
  const permissions: unknown[] = [],
    forms: unknown[] = [];
  let active: Record<string, unknown> = {};
  let override:
    | ((
        url: URL,
        init: RequestInit,
      ) => Promise<Response> | Response | undefined)
    | undefined;
  const emit = (type: string, data: unknown = {}) =>
    stream.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({ id: `evt_${++seq}`, created: seq, type, data,
          ...(type.startsWith("session.") ? { durable: { aggregateID: "ses1", seq, version: 1 } } : {}) })}\r\n\r\n`,
      ),
    );
  const endpoint: ChatEndpoint = {
    url: "https://injected.invalid/proxy/",
    async fetch(input, init = {}) {
      if (init.body instanceof Uint8Array) init = { ...init, body: new TextDecoder().decode(init.body) };
      if (typeof input !== "string")
        throw new Error("Expected string-only transport");
      const url = new URL(input);
      calls.push({ url, init });
      const result = override?.(url, init);
      if (result) return result;
      const path = url.pathname.replace("/proxy/api/", "");
      if (path === "event")
        return new Response(
          new ReadableStream({
            start(c) {
              stream = c;
              emit("server.connected");
            },
            cancel() {
              cancels++;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
       if (path === "session" && (!init.method || init.method === "GET"))
        return json({
          data: [
             session("ses1", "First"),
             session("ses2", "Second"),
          ],
          cursor: {},
        });
      if (path === "session" && init.method === "POST")
         return json({ data: session("ses_new", "New") });
      if (path === "model/default") return json({ data: null });
      if (path === "model")
        return json({
           location, data: [model],
        });
      if (path === "session/active") return json({ data: active });
      const id = path.split("/")[1]!;
      if (path.endsWith("/message"))
        return json({ data: [...(histories[id] ?? [])].reverse(), cursor: {} });
      if (path.endsWith("/permission")) return json({ data: permissions });
       if (path.endsWith("/form")) return json({ data: forms });
       if (path.endsWith("/interrupt")) return json({ interrupted: true });
       if (path.endsWith("/prompt")) return json({ data: { id: "msg_inbox", sessionID: id, type: "user", payload: { text: "accepted" }, delivery: "steer", timeCreated: 1 } });
      if (path.includes("/question")) return json({ error: "Removed endpoint" }, 404);
      return new Response(null, { status: 204 });
    },
  };
  return {
    endpoint,
    calls,
    histories,
    permissions,
    forms,
    emit,
    get cancels() {
      return cancels;
    },
    set active(value: Record<string, unknown>) {
      active = value;
    },
    set override(value: typeof override) {
      override = value;
    },
    close() {
      stream.close();
    },
  };
}
export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
