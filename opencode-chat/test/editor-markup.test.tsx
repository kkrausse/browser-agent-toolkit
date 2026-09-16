import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserEditor } from "../src/editor";
import type { WorkspaceController, WorkspaceSnapshot } from "@kev-browser-agent-kit/workspace/react";

test("editor renders a usable startup/error pane without requiring a workspace provider or host styles", () => {
  const state: WorkspaceSnapshot = {
    services: {}, clients: {}, busy: false, status: "Starting runtime", error: "Asset missing",
    progress: [], logs: ["launch failed"], persistence: "closed",
  };
  const controller = { getSnapshot: () => state, subscribe: () => () => {} } as unknown as WorkspaceController;
  const markup = renderToStaticMarkup(<BrowserEditor controller={controller} onExit={() => {}} onRetry={() => {}} />);
  expect(markup).toContain('title="Workspace preview"');
  expect(markup).toContain('aria-label="Editing controls"');
  expect(markup).toContain("Asset missing");
  expect(markup).toContain("Retry editing");
  expect(markup).toContain("Waiting for OpenCode connection");
  expect(markup).not.toContain("Save file");
});
