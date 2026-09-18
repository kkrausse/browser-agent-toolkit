import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, safeHref } from "../src/markdown";
import { ChatView } from "../src/react";
import { createChatController } from "../src/controller";
import { fixture } from "./fixture";

test("unsupported candidate forms explain the limitation in the chat UI", async () => {
  const f = fixture();
  f.forms.push({ id: "frm_budget", sessionID: "ses1", title: "Choose budget", fields: [{ key: "amount", type: "number" }] });
  const c = createChatController({ endpoint: f.endpoint, directory: "/workspace" });
  try {
    await c.ready;
    const html = renderToStaticMarkup(<ChatView controller={c} />);
    const header = html.slice(html.indexOf('<header class="oc-header">'), html.indexOf("</header>") + 9);
    expect(header).toContain("OpenCode");
    expect(header).toContain("Session &amp; model");
    expect(header).toContain('<div class="oc-toolbar-copy"><strong>OpenCode</strong><details');
    expect(html).toContain("Choose budget");
    expect(html).toContain("This form cannot be answered by this chat client");
    expect(html).toContain("amount (number)");
    const hosted = renderToStaticMarkup(<ChatView controller={c} footer={<p>Workspace ready</p>} />);
    expect(hosted).toContain("Workspace ready");
    expect(hosted).not.toContain('class="oc-connection"');
  } finally { c.dispose(); }
});
test("idle messages render as compact run statuses instead of raw JSON", async () => {
  const f = fixture();
  f.histories.ses1!.push(
    { id: "msg_idle_ok", type: "idle", outcome: "succeeded", time: { created: 1 } },
    { id: "msg_idle_failed", type: "idle", outcome: "failed", time: { created: 2 } },
    { id: "msg_idle_stopped", type: "idle", outcome: "interrupted", time: { created: 3 } },
  );
  const c = createChatController({ endpoint: f.endpoint, directory: "/workspace" });
  try {
    await c.ready;
    const html = renderToStaticMarkup(<ChatView controller={c} />);
    expect(html).toContain("Run completed");
    expect(html).toContain("Run failed");
    expect(html).toContain("Run interrupted");
    expect(html).toContain("oc-run-status-succeeded");
    expect(html).not.toContain("msg_idle_ok");
    expect(html).not.toContain('&quot;type&quot;: &quot;idle&quot;');
  } finally { c.dispose(); }
});
test("Markdown never executes HTML or unsafe links, and supports incomplete fences", () => {
  const html = renderToStaticMarkup(
    <Markdown
      text={
        '<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29)\n\n```js\nconst x = "<script>"'
      }
    />,
  );
  expect(html).not.toContain("<img");
  expect(html).not.toContain('href="javascript');
  expect(html).toContain("&lt;img");
  expect(html).toContain("const x");
  expect(html).toContain("Copy");
  for (const href of [
    "javascript:alert(1)",
    "data:text/html,x",
    "//evil.test",
    "java\nscript:alert(1)",
  ])
    expect(safeHref(href)).toBeUndefined();
  expect(safeHref("https://example.com")).toBe("https://example.com");
});
