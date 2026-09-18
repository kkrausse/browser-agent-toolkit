import { expect, test } from "bun:test";
import { installSource } from "../src/delivery";
import type { Workspace } from "../src/workspace";

function memoryWorkspace(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial).map(([path, text]) => [path, new TextEncoder().encode(text)]));
  const workspace = { fs: {
    async stat(path: string) { const bytes = files.get(path); if (!bytes) throw Error("ENOENT"); return { isDirectory: false, isFile: true, size: bytes.length }; },
    async mkdir() {},
    async writeFile(path: string, bytes: string | Uint8Array) { files.set(path, typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes); },
  } } as unknown as Workspace;
  return { workspace, text: (path: string) => new TextDecoder().decode(files.get(path)) };
}

test("source installation makes retention policy explicit", async () => {
  const memory = memoryWorkspace({ "/src/app.ts": "browser edit" });
  const source = { "/src/app.ts": "prepared source", "/src/new.ts": "new file" };
  await installSource(memory.workspace, source, { existing: "preserve" });
  expect(memory.text("/src/app.ts")).toBe("browser edit");
  expect(memory.text("/src/new.ts")).toBe("new file");
  await installSource(memory.workspace, source, { existing: "replace" });
  expect(memory.text("/src/app.ts")).toBe("prepared source");
});
