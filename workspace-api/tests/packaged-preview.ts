// Executed in the isolated tarball consumer, against built entrypoints only.
import { strict as assert } from "node:assert";
import { cp } from "node:fs/promises";
import { WorkspaceController } from "@kev-browser-agent-kit/workspace/react";
import { attachPreview, type Endpoint } from "@kev-browser-agent-kit/workspace";

await cp("node_modules/@kev-browser-agent-kit/workspace/dist/lib", "second-copy", { recursive: true });
const second = await import(new URL("./second-copy/index.js", import.meta.url).href);
assert.notEqual(second.attachPreview, attachPreview, "independent module copies must be exercised");
type Message = { type: string; reqId?: number; [key: string]: unknown };
const outgoing: Message[] = [];
let worker!: TestWorker;
class TestWorker {
  onmessage?: (event: { data: Message }) => void;
  constructor() { worker = this; }
  emit(data: Message) { this.onmessage?.({ data }); }
  postMessage(message: Message) {
    outgoing.push(message);
    queueMicrotask(() => {
      if (message.type === "init") {
        this.emit({ type: "listen", port: 5173, listenerId: "listener-one" });
        this.emit({ type: "ready" });
      } else if (message.reqId) this.emit({ type: "vv-reply", reqId: message.reqId, ok: true, persistence: { status: "durable" } });
    });
  }
  terminate() {}
}
const messages = new Set<(event: MessageEvent) => void>();
const sw = new EventTarget();
let registrations = 0;
Object.assign(sw, { register: async () => { registrations++; return {}; }, ready: Promise.resolve(), controller: { postMessage() {} } });
for (const [key, value] of Object.entries({
  Worker: TestWorker, crossOriginIsolated: true, location: { href: "http://qa.test/" },
  fetch: async () => Response.json({ abi: "workspace-v1", version: "qa", kernelWorker: "worker.js", serviceWorker: "sw.js" }),
  navigator: { serviceWorker: sw },
  window: { addEventListener: (_: string, fn: (event: MessageEvent) => void) => messages.add(fn), removeEventListener: (_: string, fn: (event: MessageEvent) => void) => messages.delete(fn) },
})) Object.defineProperty(globalThis, key, { configurable: true, value });

const controller = new WorkspaceController();
try {
  await controller.open({ name: "qa", version: "qa", assetBaseUrl: "/runtime/" });
  const runtime = await controller.startRuntime({});
  const endpoint: Endpoint = await runtime.expose(5173);
  assert.equal(registrations, 0, "expose must not register a Service Worker");
  const received: unknown[] = [];
  const contentWindow = { postMessage: (data: unknown, origin: string) => { received.push({ data, origin }); } };
  const errors: Event[] = [];
  const frame = { src: "", contentWindow, dispatchEvent(event: Event) { errors.push(event); return true; } } as unknown as HTMLIFrameElement;
  assert.throws(() => endpoint.attachPreview(frame, { hostPaths: ["/api/"] }), /hostPaths/);
  assert.equal(messages.size, 0);
  for (const attach of [
    () => endpoint.attachPreview(frame, { hostPaths: ["/api"] }),
    () => attachPreview(frame, endpoint, { hostPaths: ["/api"] }),
    () => second.attachPreview(frame, endpoint, { hostPaths: ["/api"] }),
  ]) {
    const attachment = attach();
    assert.equal(frame.src, "about:blank", "navigation waits for preview registration");
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(registrations, 1, "preview registration is shared across attachments");
    assert.equal(new URL(frame.src).searchParams.get("__vv_host_paths"), '["/api"]');
    const send = (source = contentWindow, origin = "http://qa.test") => {
      for (const receive of messages) receive({ source, origin, data: { type: "vv-ws", dir: "out", sub: "open", connId: "hmr" } } as unknown as MessageEvent);
    };
    const before = outgoing.length;
    send({ postMessage() {} }); send(contentWindow, "http://foreign.test");
    assert.equal(outgoing.length, before, "foreign windows and origins are ignored");
    send();
    const forwarded = outgoing.at(-1)!.msg as { connId: string };
    assert.notEqual(forwarded.connId, "hmr");
    assert.ok(forwarded.connId.endsWith(":hmr"));
    worker.emit({ type: "vv-ws", msg: { connId: forwarded.connId, sub: "message", data: "update" } });
    assert.deepEqual(received.at(-1), { origin: "http://qa.test", data: { connId: "hmr", sub: "message", data: "update", type: "vv-ws", dir: "in" } });
    attachment.dispose(); attachment.dispose();
    assert.equal((outgoing.at(-1)!.msg as { sub: string }).sub, "close");
    assert.equal(messages.size, 0);
    assert.equal(frame.src, "about:blank");
  }
  endpoint.attachPreview(frame);
  worker.emit({ type: "listen", port: 5173, listenerId: "replacement" });
  await endpoint.closed;
  assert.equal(messages.size, 0, "listener replacement disposes attachments");
  assert.equal(frame.src, "about:blank");
  assert.throws(() => second.attachPreview(frame, endpoint), /Listener closed/);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(errors.length, 0, "listener replacement during registration is normal disposal");
} finally { await controller.dispose(); }
console.log("Packaged React endpoint: owned method, root helper, independent copy, routing, sender validation, HMR relay and lifetime passed");
