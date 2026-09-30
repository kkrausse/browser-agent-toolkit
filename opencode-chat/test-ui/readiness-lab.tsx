import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createChatController } from "../src/controller";
import { ChatView, useChatSnapshot } from "../src/react";
import { deferred, fixture, json, session, user } from "../test/fixture";

// Every OpenCode request stays in this page's injected fixture. No server/model/storage.
const f = fixture();
const listeners = new Set<() => void>();
let revision = 0, nextSession = 0;
let creation: { id: string; response: ReturnType<typeof deferred<Response>> } | undefined;
let hydration: ReturnType<typeof deferred<Response>> | undefined;
const notify = () => { revision++; for (const listener of listeners) listener(); };
f.override = (url, init) => {
  queueMicrotask(notify);
  if (url.pathname.endsWith("/session") && init.method === "POST") {
    creation = { id: `ses_lab_${++nextSession}`, response: deferred<Response>() };
    return creation.response.promise;
  }
  if (/\/ses_lab_\d+\/message$/.test(url.pathname) && !f.histories[url.pathname.split("/").at(-2)!]) {
    hydration = deferred<Response>();
    return hydration.promise;
  }
  if (url.pathname.endsWith("/prompt")) {
    const id = url.pathname.split("/").at(-2)!;
    const draft = JSON.parse(String(init.body)).text;
    f.histories[id] = [...(f.histories[id] ?? []), user(`msg_lab_${f.calls.length}`, draft, f.calls.length)];
    // Fall through to the ordinary fixture acceptance response; never invoke inference.
  }
};
const controller = createChatController({ endpoint: f.endpoint, directory: "/hidden" });
void controller.ready.catch(console.error);

function Lab() {
  useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => revision);
  const state = useChatSnapshot(controller);
  const prompts = f.calls.filter(call => call.url.pathname.endsWith("/prompt"));
  return <>
    <h1>Chat readiness / draft lab — offline injected API</h1>
    <p>Open Session &amp; model → New chat. Type immediately. Enter must not send until both gates are released.</p>
    <nav className="lab-controls">
      <button disabled={!creation} onClick={() => {
        creation!.response.resolve(json({ data: session(creation!.id) })); creation = undefined; notify();
      }}>Release creation</button>
      <button disabled={!creation} onClick={() => {
        creation!.response.resolve(json({ error: "Lab rejected creation" }, 503)); creation = undefined; notify();
      }}>Reject creation</button>
      <button disabled={!hydration} onClick={() => {
        if (state.sessionID) f.histories[state.sessionID] = [];
        hydration!.resolve(json({ data: [], cursor: {} })); hydration = undefined; notify();
      }}>Release hydration</button>
    </nav>
    <output aria-label="Lab request counters">{JSON.stringify({
      sessionID: state.sessionID ?? null, draftKey: state.draftKey,
      loading: state.loading, pending: state.sessionOperationPending ?? false,
      promptCount: prompts.length,
      prompts: prompts.map(call => ({ path: call.url.pathname, text: JSON.parse(String(call.init.body)).text })),
    }, null, 2)}</output>
    <main><ChatView controller={controller} /></main>
  </>;
}
createRoot(document.getElementById("root")!).render(<Lab />);
