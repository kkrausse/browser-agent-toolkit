// QA-only: one unconditional, unkeyed ChatView. Child composer remounts are allowed.
import { Profiler, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { ChatView, useChatSnapshot } from "../src/react";
import { createCase, fixtureInputs } from "./controller-swap-repaired-fixture";

const listeners = new Set<() => void>();
let revision = 0;
const notify = () => { revision++; for (const listener of listeners) listener(); };
const cases = ["A", "B"].map(name => createCase(name, notify));
const identity = { profilerMounts: 0, profilerUpdates: 0, rootChanges: 0, commits: 0 };
const switches: { from: string; to: string }[] = [];

function Lab() {
  const [selected, select] = useState(0);
  const main = useRef<HTMLElement>(null);
  const initialChatRoot = useRef<Element | null>(null);
  const output = useRef<HTMLOutputElement>(null);
  useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => revision);
  const current = cases[selected]!;
  const state = useChatSnapshot(current.controller);
  // Observe the real ChatView root, not the deliberately keyed child textarea.
  useLayoutEffect(() => {
    const root = main.current!.querySelector("section.oc-chat");
    if (!root) throw new Error("QA missing ChatView root");
    if (!initialChatRoot.current) initialChatRoot.current = root;
    else if (initialChatRoot.current !== root) identity.rootChanges++;
    identity.commits++;
    root.setAttribute("data-qa-chat-root", "initial-unkeyed-chat-view");
    output.current!.textContent = JSON.stringify({
      controller: current.name, sessionID: state.sessionID, draftKey: state.draftKey,
      connection: state.connection, loading: state.loading, execution: state.execution,
      pending: state.sessionOperationPending, model: state.model, error: state.error,
      identity: { ...identity, rootSame: root === initialChatRoot.current }, switches, fixtureInputs,
      cases: cases.map(item => ({ controller: item.name, ...item.status(),
        writes: item.f.calls.filter(call => call.init.method && call.init.method !== "GET")
          .map(call => ({ path: call.url.pathname, method: call.init.method, body: call.init.body })),
      })),
    }, null, 2);
  });
  return <>
    <h1>Repaired QA: same mounted ChatView / held model operation</h1>
    <p>Injected local fixtures, identical session IDs. Controller switches discard composer-local drafts;
      A→B→A expects empty A, not restored A text. No production API claim.</p>
    <nav>{cases.map((item, index) => <button key={item.name} onClick={() => {
      switches.push({ from: current.name, to: item.name }); select(index);
    }}>Controller {item.name}</button>)}
      <button disabled={!current.status().held} onClick={current.release}>Release model mutation</button>
      <button disabled={!current.status().held} onClick={current.reject}>Reject model mutation</button>
    </nav>
    <output ref={output} aria-label="QA receipts" />
    <main ref={main}><Profiler id="unkeyed-chat-view" onRender={(_id, phase) => {
      if (phase === "mount") identity.profilerMounts++; else identity.profilerUpdates++;
    }}><ChatView controller={current.controller} /></Profiler></main>
  </>;
}
createRoot(document.getElementById("root")!).render(<Lab />);
