import { expect, test } from "bun:test";

import { clearWorkspaceSource, workspaceInternals, type Workspace } from "../src/workspace.js";
import type { Host } from "../src/host.js";

function fixture(names: string[], options: { stuck?: string } = {}) {
  const removed: string[] = [], listed: string[] = [];
  let entries = [...names], flushes = 0;
  const host = {
    stat: async () => ({ exists: true, isDirectory: true, isFile: false, size: 0 }),
    readdir: async (path: string) => { listed.push(path); return [...entries]; },
    remove: async (path: string) => { removed.push(path); if (path !== options.stuck) entries = entries.filter(name => "/workspace/" + name !== path); },
    flush: async () => { flushes++; },
  } as unknown as Host;
  const workspace = {} as Workspace;
  // Attached: unlike clearWorkspace, this runs under a live runtime.
  workspaceInternals.set(workspace, { host, distribution: { name: "vivari", version: "test", assetBaseUrl: "/runtime/" }, attached: true, clearing: false, closed: false });
  return { workspace, removed, listed, flushes: () => flushes, state: () => workspaceInternals.get(workspace)! };
}

test("source clear removes only top-level /workspace entries that are not kept, under an attached runtime", async () => {
  const f = fixture(["src", ".server", "package.json", "node_modules", ".todo-workspace.json", ".browser-editor-backends", ".git"]);
  await clearWorkspaceSource(f.workspace, { keep: [".server", "node_modules", ".browser-editor-backends"] });
  expect(f.removed).toEqual(["/workspace/src", "/workspace/package.json", "/workspace/.todo-workspace.json", "/workspace/.git"]);
  // Kept roots are not listed into, and no other root is inspected.
  expect(new Set(f.listed)).toEqual(new Set(["/workspace"]));
  expect(f.flushes()).toBe(1);
  expect(f.state().clearing).toBe(false);
});

test("source clear refuses an empty or unsafe keep list before removing anything, and reports leftovers", async () => {
  const f = fixture(["src", ".server"]);
  await expect(clearWorkspaceSource(f.workspace, { keep: [] })).rejects.toThrow("entries to keep");
  for (const name of ["", ".", "..", "a/b", ".server/config"]) await expect(clearWorkspaceSource(f.workspace, { keep: [name] })).rejects.toThrow("Invalid directory entry");
  expect(f.removed).toEqual([]);
  f.state().clearing = true;
  await expect(clearWorkspaceSource(f.workspace, { keep: [".server"] })).rejects.toMatchObject({ code: "STORAGE_BUSY" });
  f.state().clearing = false;
  const stuck = fixture(["src", ".server"], { stuck: "/workspace/src" });
  await expect(clearWorkspaceSource(stuck.workspace, { keep: [".server"] })).rejects.toThrow("verification failed");
  expect(stuck.state().clearing).toBe(false);
});
