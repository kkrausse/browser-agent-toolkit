import "./dom";
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createChatController } from "../src/controller";
import { ChatView } from "../src/react";
import type { ChatController } from "../src/types";
import { deferred, fixture, json, session } from "../test/fixture";

let root: Root | undefined;
const controllers: ChatController[] = [];
const responses: ReturnType<typeof deferred<Response>>[] = [];
const responseGate = () => {
  const gate = deferred<Response>();
  responses.push(gate);
  return gate;
};
const start = async () => {
  const f = fixture();
  const c = createChatController({ endpoint: f.endpoint, directory: "/hidden" });
  controllers.push(c);
  await c.ready;
  return { f, c };
};
const mount = async (controller: ChatController) => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<ChatView controller={controller} />); });
  return container;
};
const type = async (container: Element, text: string) => {
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const submit = async (container: Element, enter = false) => {
  await act(async () => {
    if (enter) container.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    else container.querySelector("form.oc-composer")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
};
const text = (container: Element) => container.querySelector("textarea")!.value;
const sendButton = (container: Element) => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const cancelSend = (container: Element) => [...container.querySelectorAll("button")].find(b => b.textContent === "Cancel send");
const prompts = (f: ReturnType<typeof fixture>) => f.calls.filter(call => call.url.pathname.endsWith("/prompt"));
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  // Release fixture gates even when a regression assertion fails mid-request.
  for (const gate of responses.splice(0)) gate.resolve(json({}, 503));
  await Promise.all(controllers.splice(0).map(c => c.dispose()));
  document.body.innerHTML = "";
});

// Observed live (run 3): Enter 98 ms after New chat, during "Preparing chat…", did
// nothing and said nothing; the text stayed until a second Enter. The keystroke is
// now a visible queued send, delivered exactly once when the chat becomes ready.
test("New chat click admits a new logical draft synchronously; an immediate Enter is queued visibly and sent exactly once when ready", async () => {
  const { f, c } = await start();
  const container = await mount(c);
  await type(container, "old draft");
  const creation = responseGate();
  f.override = (url, init) => {
    if (url.pathname.endsWith("/session") && init.method === "POST") return creation.promise;
  };
  const button = [...container.querySelectorAll("button")].find(b => b.textContent === "New chat")!;
  // Neither async act nor request/pending-state synchronization may precede input.
  act(() => { button.click(); });
  const admitted = c.getSnapshot();
  const beforeInput = text(container);
  act(() => {
    const textarea = container.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, textarea.value + "immediate new draft");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect({ sessionID: admitted.sessionID, pending: admitted.sessionOperationPending ?? false, beforeInput, text: text(container) })
    .toEqual({ sessionID: undefined, pending: true, beforeInput: "", text: "immediate new draft" });
  expect(text(container)).toBe("immediate new draft");
  expect(container.querySelector(".oc-composer [role=status]")!.textContent).toContain("Sends when the chat is ready");
  expect(cancelSend(container)).toBeDefined();
  // Impatient repeats while it waits must not add sends.
  await submit(container, true);
  await submit(container);
  expect(prompts(f)).toHaveLength(0);
  await act(async () => { creation.resolve(json({ data: session("ses_immediate") })); });
  await act(async () => { await Bun.sleep(5); });
  expect(c.getSnapshot().sessionID).toBe("ses_immediate");
  expect(c.getSnapshot().draftKey).toBe(admitted.draftKey);
  expect(prompts(f)).toHaveLength(1);
  expect(prompts(f)[0]!.url.pathname).toContain("/ses_immediate/prompt");
  expect(JSON.parse(String(prompts(f)[0]!.init.body)).text).toBe("immediate new draft");
  expect(text(container)).toBe("");
  expect(cancelSend(container)).toBeUndefined();
  expect(c.getSnapshot().error).toBeUndefined();
  // Nothing is left queued: another Enter, or going away and back, sends nothing more.
  await submit(container, true);
  await act(async () => { await c.selectSession("ses1"); });
  expect(text(container)).toBe("old draft");
  await act(async () => { await c.selectSession("ses_immediate"); });
  expect(prompts(f)).toHaveLength(1);
});

test("send control is disabled while creation is pending rather than advertising a send the controller rejects", async () => {
  const { f, c } = await start();
  const container = await mount(c);
  const creation = responseGate(), started = deferred<void>();
  f.override = (url, init) => {
    if (url.pathname.endsWith("/session") && init.method === "POST") {
      started.resolve(); return creation.promise;
    }
  };
  let creating!: Promise<string>;
  await act(async () => { creating = c.createSession(); void creating.catch(() => {}); await started.promise; });
  await type(container, "immediate prompt");
  await act(async () => { await expect(c.send({ text: "immediate prompt" })).rejects.toThrow("not ready"); });
  expect(sendButton(container).disabled).toBe(true);
  await act(async () => { creation.resolve(json({ data: session("ses_new") })); await creating; });
});

test("same-turn duplicate creation and pending send are rejected; selection cancels unscheduled creation without late errors", async () => {
  const { f, c } = await start();
  const creating = c.createSession();
  void creating.catch(() => {});
  const key = c.getSnapshot().draftKey;
  const duplicate = c.createSession();
  void duplicate.catch(() => {});
  expect(c.getSnapshot().draftKey).toBe(key);
  const sending = c.send({ text: "must never queue" });
  void sending.catch(() => {});
  const selecting = c.selectSession("ses2");
  expect(c.getSnapshot().sessionID).toBe("ses2");
  expect(c.getSnapshot().sessionOperationPending).toBe(false);
  await selecting;
  await expect(creating).rejects.toThrow("abandoned");
  await expect(duplicate).rejects.toThrow("pending");
  await expect(sending).rejects.toThrow("not ready");
  expect(c.getSnapshot().error).toBeUndefined();
  expect(f.calls.filter(call => call.url.pathname.endsWith("/session") && call.init.method === "POST")).toHaveLength(0);
  expect(f.calls.filter(call => call.url.pathname.endsWith("/prompt"))).toHaveLength(0);
});

test("a send admitted in an old selection cannot target a newly selected session before its fiber starts", async () => {
  const { f, c } = await start();
  const sending = c.send({ text: "old selection only" });
  void sending.catch(() => {});
  await c.selectSession("ses2");
  await expect(sending).rejects.toThrow();
  expect(c.getSnapshot().sessionID).toBe("ses2");
  expect(c.getSnapshot().error).toBeUndefined();
  expect(f.calls.filter(call => call.url.pathname.endsWith("/prompt"))).toHaveLength(0);
});

test("a queued send survives ID assignment and hydration unsent, and cancelling it keeps the draft without ever sending", async () => {
  const { f, c } = await start();
  const container = await mount(c);
  await type(container, "old session draft");
  expect(text(container)).toBe("old session draft");
  const creation = responseGate(), createStarted = deferred<void>();
  const history = responseGate(), historyStarted = deferred<void>();
  f.override = (url, init) => {
    if (url.pathname.endsWith("/session") && init.method === "POST") {
      createStarted.resolve(); return creation.promise;
    }
    if (url.pathname.endsWith("/ses_new/message")) {
      historyStarted.resolve(); return history.promise;
    }
  };
  let creating!: Promise<string>;
  await act(async () => { creating = c.createSession(); void creating.catch(() => {}); await createStarted.promise; });
  const key = c.getSnapshot().draftKey;
  expect(c.getSnapshot().sessionOperationPending).toBe(true);
  expect(c.getSnapshot().sessionID).toBeUndefined();
  expect(text(container)).toBe("");
  await type(container, "new chat prompt");
  expect(sendButton(container).disabled).toBe(true);
  expect(container.querySelector("footer")!.textContent).toContain("Preparing chat");
  await submit(container);
  await submit(container, true);
  expect(cancelSend(container)).toBeDefined();
  expect(f.calls.filter(call => call.url.pathname.endsWith("/prompt"))).toHaveLength(0);
  await act(async () => { creation.resolve(json({ data: session("ses_new") })); await historyStarted.promise; });
  expect(c.getSnapshot().sessionID).toBe("ses_new");
  expect(c.getSnapshot().draftKey).toBe(key);
  expect(text(container)).toBe("new chat prompt");
  // Still preparing (history), still queued, still nothing sent.
  await submit(container, true);
  expect(cancelSend(container)).toBeDefined();
  expect(f.calls.filter(call => call.url.pathname.endsWith("/prompt"))).toHaveLength(0);
  await act(async () => { cancelSend(container)!.click(); });
  expect(cancelSend(container)).toBeUndefined();
  await act(async () => { history.resolve(json({ data: [], cursor: {} })); await creating; });
  await act(async () => { await Bun.sleep(5); });
  expect(sendButton(container).disabled).toBe(false);
  expect(text(container)).toBe("new chat prompt");
  expect(f.calls.filter(call => call.url.pathname.endsWith("/prompt"))).toHaveLength(0);
  expect(c.getSnapshot().error).toBeUndefined();
  f.override = undefined;
  await act(async () => { await c.selectSession("ses1"); });
  expect(text(container)).toBe("old session draft");
  await act(async () => { await c.selectSession("ses_new"); });
  expect(text(container)).toBe("new chat prompt");
  await submit(container);
  expect(text(container)).toBe("");
  const prompts = f.calls.filter(call => call.url.pathname.endsWith("/prompt"));
  expect(prompts).toHaveLength(1);
  expect(prompts[0]!.url.pathname).toContain("/ses_new/prompt");
  expect(JSON.parse(String(prompts[0]!.init.body)).text).toBe("new chat prompt");
});

test("text entered before the creation response is not discarded when the session ID arrives", async () => {
  const { f, c } = await start();
  const container = await mount(c);
  const creation = responseGate(), started = deferred<void>();
  f.override = (url, init) => {
    if (url.pathname.endsWith("/session") && init.method === "POST") {
      started.resolve(); return creation.promise;
    }
  };
  let creating!: Promise<string>;
  await act(async () => { creating = c.createSession(); void creating.catch(() => {}); await started.promise; });
  await type(container, "prompt before ID");
  await act(async () => { creation.resolve(json({ data: session("ses_new") })); await creating; });
  expect(text(container)).toBe("prompt before ID");
  expect(f.calls.filter(call => call.url.pathname.endsWith("/prompt"))).toHaveLength(0);
});

test("failed creation retains the pending draft for explicit retry, not a send into the previous chat", async () => {
  const { f, c } = await start();
  const container = await mount(c);
  const creation = responseGate(), started = deferred<void>();
  f.override = (url, init) => {
    if (url.pathname.endsWith("/session") && init.method === "POST") {
      started.resolve(); return creation.promise;
    }
  };
  let creating!: Promise<string>;
  await act(async () => { creating = c.createSession(); void creating.catch(() => {}); await started.promise; });
  await type(container, "retry me");
  // A send queued while preparing must not outlive the failed preparation.
  await submit(container, true);
  expect(cancelSend(container)).toBeDefined();
  await act(async () => { creation.resolve(json({ error: "creation rejected" }, 503)); await creating.catch(() => {}); });
  expect(cancelSend(container)).toBeUndefined();
  expect(container.querySelector(".oc-error")!.textContent).toContain("503");
  expect(text(container)).toBe("retry me");
  expect(c.getSnapshot().sessionID).toBeUndefined();
  expect(c.getSnapshot().sessionOperationPending).toBe(false);
  expect(c.getSnapshot().error).toContain("503");
  expect(sendButton(container).disabled).toBe(true);
  await submit(container, true);
  f.override = undefined;
  await act(async () => { await c.createSession(); });
  await act(async () => { await Bun.sleep(5); });
  expect(text(container)).toBe("retry me");
  expect(sendButton(container).disabled).toBe(false);
  expect(f.calls.filter(call => call.url.pathname.endsWith("/prompt"))).toHaveLength(0);
});

test("selecting another session abandons pending creation without migrating its draft or selection", async () => {
  const { f, c } = await start();
  const container = await mount(c);
  const creation = responseGate(), started = deferred<void>();
  f.override = (url, init) => {
    if (url.pathname.endsWith("/session") && init.method === "POST") {
      started.resolve(); return creation.promise;
    }
  };
  let creating!: Promise<string>;
  await act(async () => { creating = c.createSession(); void creating.catch(() => {}); await started.promise; });
  await type(container, "abandoned new chat");
  await act(async () => { await c.selectSession("ses2"); });
  await type(container, "second chat only");
  await act(async () => { creation.resolve(json({ data: session("ses_new") })); await creating; });
  expect(c.getSnapshot().sessionID).toBe("ses2");
  expect(c.getSnapshot().sessionOperationPending).toBe(false);
  expect(text(container)).toBe("second chat only");
  expect(f.calls.filter(call => call.url.pathname.endsWith("/prompt"))).toHaveLength(0);
});

test("model mutation publishes send readiness; a send queued during it is withdrawn by editing and nothing is sent", async () => {
  const { f, c } = await start();
  const container = await mount(c);
  await type(container, "after model selection");
  const response = responseGate(), started = deferred<void>();
  f.override = url => {
    if (url.pathname.endsWith("/ses1/model")) {
      started.resolve(); return response.promise;
    }
  };
  let selecting!: Promise<void>;
  await act(async () => { selecting = c.selectModel({ providerID: "p", id: "m" }); await started.promise; });
  expect(c.getSnapshot().sessionOperationPending).toBe(true);
  expect(sendButton(container).disabled).toBe(true);
  await submit(container, true);
  expect(cancelSend(container)).toBeDefined();
  await type(container, "after model selection, edited");
  expect(cancelSend(container)).toBeUndefined();
  await act(async () => { response.resolve(new Response(null, { status: 204 })); await selecting; });
  await act(async () => { await Bun.sleep(5); });
  expect(sendButton(container).disabled).toBe(false);
  expect(text(container)).toBe("after model selection, edited");
  expect(f.calls.filter(call => call.url.pathname.endsWith("/prompt"))).toHaveLength(0);
});

test("same-view controller prop switch isolates drafts, preserves a rejected send and ignores a late completion in another session", async () => {
  const { c } = await start();
  const { c: other } = await start();
  const container = await mount(c);
  await type(container, "same ID, different controller");
  await act(async () => { root!.render(<ChatView controller={other} />); });
  expect(text(container)).toBe("");
  const rejected = deferred<void>();
  other.send = () => rejected.promise;
  await type(container, "keep on rejection");
  await submit(container);
  await act(async () => { rejected.reject(new Error("not ready")); });
  expect(text(container)).toBe("keep on rejection");
  const accepted = deferred<void>();
  other.send = () => accepted.promise;
  await submit(container);
  await act(async () => { await other.selectSession("ses2"); });
  await type(container, "keep newer session text");
  await act(async () => { accepted.resolve(); });
  expect(text(container)).toBe("keep newer session text");
  await act(async () => { await other.selectSession("ses1"); });
  expect(text(container)).toBe("");
});
