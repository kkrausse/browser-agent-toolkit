import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bundleDirectory, bundleVfsImage, cacheMatches, fingerprint, markCache, writeFile as atomicWrite } from "../src/prepare";
import { createHash } from "node:crypto";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function temporary() { const root = await mkdtemp(join(tmpdir(), "workspace-prepare-test-")); roots.push(root); return root; }

test("cache identity covers selected bytes and requires every output", async () => {
  const root = await temporary();
  await writeFile(join(root, "package.json"), "one");
  await writeFile(join(root, "bun.lock"), "lock");
  const identity = await fingerprint({ rootDir: root, files: ["package.json", "bun.lock"], values: { runtime: "r1", policy: "p1" } });
  const output = join(root, "output", "bundle");
  await mkdir(output, { recursive: true });
  const receiptPath = join(root, "cache.json");
  await markCache({ receiptPath, fingerprint: identity, outputs: [output] });
  expect(await cacheMatches({ receiptPath, fingerprint: identity, outputs: [output] })).toBe(true);
  await rm(output, { recursive: true });
  expect(await cacheMatches({ receiptPath, fingerprint: identity, outputs: [output] })).toBe(false);
  await writeFile(join(root, "package.json"), "two");
  expect(await fingerprint({ rootDir: root, files: ["package.json", "bun.lock"], values: { runtime: "r1", policy: "p1" } })).not.toBe(identity);
});

test("managed VFS image retains policy-compressed bodies in a bounded frame", async () => {
  const root = await temporary(), assets = join(root, "assets");
  await mkdir(assets);
  const bytes = new TextEncoder().encode("compressible managed file\n".repeat(1000));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(assets, sha256 + ".bin"), bytes);
  const image = await bundleVfsImage({ entries: [
    { kind: "directory", destination: "/managed", mode: 0o755 },
    { kind: "file", destination: "/managed/file", mode: 0o640, file: sha256 + ".bin", bytes: bytes.length, sha256 },
  ], assetDir: assets });
  const frame = Bun.gunzipSync(await readFile(join(assets, image.file)));
  const headerBytes = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + headerBytes)));
  expect(header.v).toBe(1); expect(header.codec).toBe("vfs-zlib-6-v1"); expect(header.bodies[0][0]).toBe(1);
  const bodyBytes = Number(header.bodies[0][1]);
  expect(bodyBytes).toBeLessThan(bytes.length * 0.95);
  expect(frame.length).toBe(4 + headerBytes + bodyBytes);
});

test("atomic write and managed bundle emit content-addressed output", async () => {
  const root = await temporary(), tree = join(root, "tree"), output = join(root, "output");
  await mkdir(join(tree, "bin"), { recursive: true });
  await writeFile(join(tree, "bin", "tool"), "tool bytes", { mode: 0o755 });
  const delivery = await bundleDirectory({ directory: tree, outputDir: output, destination: "/managed/tools" });
  expect(delivery.roots).toEqual(["/managed/tools"]);
  expect(delivery.entries.find(entry => entry.destination === "/managed/tools/bin/tool")).toMatchObject({ kind: "file", mode: 0o755, bytes: 10 });
  expect((await readFile(join(output, delivery.bundle.file))).length).toBe(delivery.bundle.bytes);
  await atomicWrite(join(output, "manifest.json"), JSON.stringify(delivery));
  expect(JSON.parse(await readFile(join(output, "manifest.json"), "utf8")).format).toBe("managed-tree-v1");
});
