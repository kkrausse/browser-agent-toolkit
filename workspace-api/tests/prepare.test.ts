import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bundleDirectory, cacheMatches, fingerprint, markCache, writeFile as atomicWrite } from "../src/prepare";

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
