// QA-only wrapper: one mounted ChatView, two independent injected controllers.
// The QA server resolves these three imports exclusively to frozen candidate source.
import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createChatController } from "../src/controller";
import { ChatView, useChatSnapshot } from "../src/react";
import { deferred, fixture, json } from "../test/fixture";

const listeners = new Set<() => void>();
let revision = 0;
const notify = () => { revision++; for (const listener of listeners) listener(); };
const cases = ["A", "B"].map(name => {
  const f = fixture();
  let modelGate: ReturnType<typeof deferred<Response>> | undefined;
  f.override = (url, init) => {
    queueMicrotask(notify);
    if (init.method && init.method !== "GET" && !url.pathname.endsWith("/prompt")) {
      modelGate = deferred<Response>();
      return modelGate.promise;
    }
  };
  const controller = createChatController({ endpoint: f.endpoint, directory: "/hidden" });
  void controller.ready.catch(console.error);
  return { name, f, controller, held: () => !!modelGate, release: () => {
    modelGate!.resolve(json({ data: {} })); modelGate = undefined; notify();
  } };
});

function Lab() {
  const [selected, select] = useState(0);
  useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => revision);
  const current = cases[selected]!;
  const state = useChatSnapshot(current.controller);
  return <>
    <h1>QA-only same-mounted-view controller switch</h1>
    <p>Independent local fixtures, identical session IDs. No key or conditional ChatView remount.</p>
    <nav>{cases.map((item, index) => <button key={item.name} onClick={() => select(index)}>Controller {item.name}</button>)}
      <button disabled={!current.held()} onClick={current.release}>Release model mutation</button>
    </nav>
    <output>{JSON.stringify({ controller: current.name, sessionID: state.sessionID,
      draftKey: state.draftKey, loading: state.loading, pending: state.sessionOperationPending,
      calls: cases.map(item => ({ controller: item.name, writes: item.f.calls.filter(call => call.init.method && call.init.method !== "GET").map(call => ({ path: call.url.pathname, body: call.init.body })) })),
    }, null, 2)}</output>
    <main><ChatView controller={current.controller} /></main>
  </>;
}
createRoot(document.getElementById("root")!).render(<Lab />);
