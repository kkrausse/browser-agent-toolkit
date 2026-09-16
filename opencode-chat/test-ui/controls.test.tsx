import "./dom";
import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChoiceSelect } from "../src/components/ui/select";
import { Button } from "../src/components/ui/button";
import { QuestionCard } from "../src/react";
import type { ChatController, QuestionRequest } from "../src/types";
import { BrowserEditor } from "../src/editor";
import type { WorkspaceController, WorkspaceSnapshot } from "@kev-browser-agent-kit/workspace/react";

let root: Root | undefined;
const mount = async (node: React.ReactNode) => {
  const container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(node); });
  return container;
};
afterEach(async () => {
  await act(async () => { root?.unmount(); }); root = undefined;
  document.body.innerHTML = "";
});
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click(); }); };

test("Base UI select opens a portaled listbox and chooses a value without submitting a form", async () => {
  let submitted = 0;
  function Example() {
    const [value, setValue] = useState("first");
    return <form onSubmit={event => { event.preventDefault(); submitted++; }}>
      <ChoiceSelect label="Session" value={value} onValueChange={setValue} items={[{ value: "first", label: "First chat" }, { value: "second", label: "Second chat" }]} />
      <Button>Ordinary action</Button><output>{value}</output>
    </form>;
  }
  const container = await mount(<Example />);
  const trigger = container.querySelector('[role="combobox"]')!;
  expect(trigger.getAttribute("aria-label")).toBe("Session");
  await click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const popup = document.querySelector('[data-slot="select-content"]')!;
  expect(popup).not.toBeNull();
  expect(container.contains(popup)).toBe(false);
  const option = [...popup.querySelectorAll('[role="option"]')].find(node => node.textContent === "Second chat")!;
  await click(option);
  expect(container.querySelector("output")!.textContent).toBe("second");
  await click(container.querySelector('[data-slot="button"]')!);
  expect(submitted).toBe(0);
});

test("Base UI select supports keyboard opening, navigation and selection", async () => {
  let selected = "";
  const container = await mount(<ChoiceSelect label="Model" value="" placeholder="Choose" onValueChange={value => { selected = value; }} items={[{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }]} />);
  const trigger = container.querySelector<HTMLElement>('[role="combobox"]')!;
  const key = async (value: string) => { await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })); }); };
  await act(async () => { trigger.focus(); });
  await key("ArrowDown");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await key("ArrowDown");
  await key("Enter");
  expect(selected).toBe("b");
});

test("question radio and checkbox primitives preserve pinned reply answer arrays", async () => {
  const replies: string[][][] = [];
  const controller = { replyQuestion: async (_id: string, answers: string[][]) => { replies.push(answers); }, rejectQuestion: async () => {} } as unknown as ChatController;
  const request = {
    id: "q1", questions: [
      { header: "Single", question: "Choose one", custom: false, options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }] },
      { header: "Multiple", question: "Choose several", multiple: true, custom: false, options: [{ label: "C" }, { label: "D" }] },
    ],
  } as QuestionRequest;
  const container = await mount(<QuestionCard controller={controller} entry={{ request, submitting: false }} />);
  await click(container.querySelectorAll('[role="radio"]')[1]!);
  expect(container.querySelectorAll('[role="radio"]')[1]!.getAttribute("aria-checked")).toBe("true");
  // Happy DOM does not implement the synthesized input click used by Base UI's
  // span root. Activate the real hidden checkbox input for its change event.
  await click(container.querySelectorAll('input[type="checkbox"]')[0]!);
  expect(container.querySelectorAll('[role="checkbox"]')[0]!.getAttribute("aria-checked")).toBe("true");
  await click(container.querySelectorAll('input[type="checkbox"]')[1]!);
  const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(submit.disabled).toBe(false);
  await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(replies).toEqual([[["B"], ["C", "D"]]]);
});

test("chat and preview panel gates host reset during startup and exposes no manual source editor", async () => {
  let resets = 0;
  const listeners = new Set<() => void>();
  let state = {
    workspace: { id: "local" },
    runtime: {}, services: {}, clients: {}, busy: true, status: "Starting", error: "", progress: [], logs: [], persistence: "local",
  } as unknown as WorkspaceSnapshot;
  const controller = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reportError: (error: unknown) => { throw error; },
  } as unknown as WorkspaceController;
  const container = await mount(<BrowserEditor controller={controller} onReset={async () => { resets++; }} />);
  const reset = [...container.querySelectorAll("button")].find(button => button.textContent === "Reset source")!;
  expect(reset.disabled).toBe(true);
  await act(async () => { state = { ...state, busy: false }; listeners.forEach(listener => listener()); });
  expect(reset.disabled).toBe(false);
  await click(reset);
  expect(resets).toBe(1);
  expect(container.querySelector('[aria-label="Source editor"]')).toBeNull();
  expect(container.querySelector('iframe[title="Workspace preview"]')).not.toBeNull();
  expect(container.textContent).toContain("Waiting for OpenCode connection");
});
