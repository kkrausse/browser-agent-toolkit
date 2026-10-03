import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { installSource, managedDeliveryTool } from "../src/delivery";
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

test("managed delivery selects and validates a VFS image when the runtime supports it", async () => {
  const bytes = new TextEncoder().encode("image bytes");
  const fileHash = createHash("sha256").update(bytes).digest("hex");
  const header = new TextEncoder().encode(JSON.stringify({ v: 1, codec: "vfs-zlib-6-v1", bodies: [[0, bytes.length]] }));
  const frame = new Uint8Array(4 + header.length + bytes.length);
  new DataView(frame.buffer).setUint32(0, header.length, true); frame.set(header, 4); frame.set(bytes, 4 + header.length);
  const compressed = Bun.gzipSync(frame), imageHash = createHash("sha256").update(compressed).digest("hex");
  const delivery = { format: "managed-tree-v1" as const, roots: ["/managed"], entries: [
    { kind: "directory" as const, destination: "/managed", mode: 0o755 },
    { kind: "file" as const, destination: "/managed/file", mode: 0o640, file: fileHash + ".bin", bytes: bytes.length, sha256: fileHash },
  ], bundle: { file: "f".repeat(64) + ".bundle.gz", bytes: 1, sha256: "f".repeat(64) },
    image: { format: "managed-vfs-image-v1" as const, file: imageHash + ".image.gz", bytes: compressed.length, sha256: imageHash } };
  let installed: Parameters<NonNullable<import("../src/types").ToolContext["installTreeImage"]>>[0] | undefined;
  const context = { installTree: async () => { throw Error("legacy path selected"); }, installTreeImage: async tree => {
    installed = tree; return { files: 1, verifyMs: 1, installMs: 1, readbackMs: 0 };
  } } as import("../src/types").ToolContext;
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => new Response(compressed));
  try {
    const install = await managedDeliveryTool(delivery, { baseUrl: "/", signal: new AbortController().signal }).bind(context);
    await install();
    expect(fetch.mock.calls[0]?.[0]).toBe("/" + delivery.image.file);
    expect(installed?.entries[1]).toMatchObject({ kind: "file", logicalBytes: bytes.length, encoding: 0, sha256: fileHash });
    // The image passed its digest check, so the runtime is told not to hash each file again.
    expect(installed?.bodiesVerified).toBe(true);
    // Managed roots are rewritten on every open, so they are kept out of the OPFS mirror.
    expect(installed?.persist).toBe(false);
    installed = undefined;
    await (await managedDeliveryTool(delivery, { baseUrl: "/", signal: new AbortController().signal, verifyImageFiles: true }).bind(context))();
    expect(installed?.bodiesVerified).toBe(false);
    installed = undefined;
    await (await managedDeliveryTool(delivery, { baseUrl: "/", signal: new AbortController().signal, persistManagedRoots: true }).bind(context))();
    expect(installed?.persist).toBe(true);
  } finally { fetch.mockRestore(); }
});

test("an image that fails its digest is never installed, and the bundle path keeps per-file verification", async () => {
  const bytes = new TextEncoder().encode("bundle bytes");
  const fileHash = createHash("sha256").update(bytes).digest("hex");
  const compressed = Bun.gzipSync(bytes), bundleHash = createHash("sha256").update(compressed).digest("hex");
  const entries = [
    { kind: "directory" as const, destination: "/managed", mode: 0o755 },
    { kind: "file" as const, destination: "/managed/file", mode: 0o640, file: fileHash + ".bin", bytes: bytes.length, sha256: fileHash },
  ];
  const bundle = { file: bundleHash + ".bundle.gz", bytes: compressed.length, sha256: bundleHash };
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => new Response(compressed));
  try {
    // Same bytes offered as an image whose manifest digest they do not match.
    let imageInstalls = 0;
    const tampered = { format: "managed-tree-v1" as const, roots: ["/managed"], entries, bundle,
      image: { format: "managed-vfs-image-v1" as const, file: "e".repeat(64) + ".image.gz", bytes: compressed.length, sha256: "e".repeat(64) } };
    const imageContext = { installTree: async () => { throw Error("legacy path selected"); },
      installTreeImage: async () => { imageInstalls++; return { files: 0, verifyMs: 0, installMs: 0, readbackMs: 0 }; } } as import("../src/types").ToolContext;
    await expect((await managedDeliveryTool(tampered, { baseUrl: "/", signal: new AbortController().signal }).bind(imageContext))()).rejects.toThrow("integrity failure");
    expect(imageInstalls).toBe(0);
    // No image support: files come from the bundle and go through installTree, which
    // has no skip and hashes each of them in the runtime.
    let legacy: Parameters<import("../src/types").ToolContext["installTree"]>[0] | undefined;
    const bundleContext = { installTree: async tree => { legacy = tree; return { files: 1, verifyMs: 1, installMs: 1, readbackMs: 0 }; } } as import("../src/types").ToolContext;
    await (await managedDeliveryTool({ format: "managed-tree-v1", roots: ["/managed"], entries, bundle }, { baseUrl: "/", signal: new AbortController().signal }).bind(bundleContext))();
    expect(legacy?.entries[1]).toMatchObject({ kind: "file", sha256: fileHash });
    expect(legacy).not.toHaveProperty("bodiesVerified");
  } finally { fetch.mockRestore(); }
});

test("managed delivery accepts package bins through an isolated-linker symlink", () => {
  expect(() => managedDeliveryTool({
    format: "managed-tree-v1",
    roots: ["/workspace/node_modules"],
    entries: [
      { kind: "directory", destination: "/workspace/node_modules", mode: 0o755 },
      { kind: "directory", destination: "/workspace/node_modules/.bin", mode: 0o755 },
      { kind: "directory", destination: "/workspace/node_modules/.bun", mode: 0o755 },
      { kind: "directory", destination: "/workspace/node_modules/.bun/tool", mode: 0o755 },
      { kind: "directory", destination: "/workspace/node_modules/.bun/tool/node_modules", mode: 0o755 },
      { kind: "directory", destination: "/workspace/node_modules/.bun/tool/node_modules/tool", mode: 0o755 },
      { kind: "file", destination: "/workspace/node_modules/.bun/tool/node_modules/tool/bin.js", mode: 0o755,
        file: "a".repeat(64) + ".bin", bytes: 1, sha256: "a".repeat(64) },
      { kind: "symlink", destination: "/workspace/node_modules/tool", target: ".bun/tool/node_modules/tool" },
      { kind: "symlink", destination: "/workspace/node_modules/.bin/tool", target: "../tool/bin.js" },
    ],
    bundle: { file: "b".repeat(64) + ".bundle.gz", bytes: 1, sha256: "b".repeat(64) },
  }, { baseUrl: "/", signal: new AbortController().signal })).not.toThrow();
});
