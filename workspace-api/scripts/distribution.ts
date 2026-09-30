// Explicit distribution delivery. Build the fork first; package its receipted
// output with the versioned preview query adapter.
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { preservePreviewQuery } from './preview-query';
import { runtimeSourcePath } from '../../vivari/scripts/runtime-source.mjs';
import { inspectRuntimeAssets } from './runtime-assets';
const root = resolve(import.meta.dir, "../..");
const source = runtimeSourcePath("packages/core/dist");
const destination = resolve(process.argv[2] ?? resolve(root, "workspace-api/dist/runtime"));
const receiptBytes = await readFile(resolve(root, "vivari/.runtime/patched-build.json"));
const runtimeBuild = JSON.parse(receiptBytes.toString());
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
if (runtimeBuild.mode !== "fork" || !runtimeBuild.assets?.length) throw new Error("Build the fork runtime before packaging its distribution");
if (resolve(runtimeBuild.source?.path ?? '') !== resolve(source, '../../..')) throw Error('Runtime source differs from build receipt; rebuild with the explicit VIVARI_SOURCE');
const { kernelWorker, topology } = await inspectRuntimeAssets(runtimeBuild.assets, name => readFile(resolve(source, name)), process.env.VIVARI_WORKER_TOPOLOGY === 'single-kernel');
// Never relabel a four-slot distribution as the integrated six-slot ABI.
const protocolPath = 'packages/protocol/syscall.js';
const protocolBytes = await readFile(runtimeSourcePath(protocolPath));
if (runtimeBuild.source?.files?.find((file: { name: string }) => file.name === protocolPath)?.sha256 !== sha256(protocolBytes)) throw Error('Protocol differs from runtime build receipt');
const protocol = await import(runtimeSourcePath(protocolPath));
if (protocol.CTRL_SLOTS !== 6 || protocol.OP_SQLITE !== 39) throw Error('Distribution requires six-slot SAB and SQLite opcode 39');
const kernelBytes = await readFile(resolve(source, kernelWorker));
if (!kernelBytes.includes(Buffer.from("workspace-flush"))) throw new Error("Runtime output lacks workspace-v1; rebuild fork source first");
if (!kernelBytes.includes(Buffer.from("workspace-install-tree-image"))) throw new Error("Runtime output lacks prepared tree image installation; rebuild fork source first");
if (/new URL\(\s*["']\/assets\//.test(kernelBytes.toString())) {
  throw new Error("Runtime nested workers are root-absolute; rebuild core with a relative Vite base before delivery");
}
const serviceWorker = preservePreviewQuery(await readFile(resolve(source, 'assets/sw.js'), 'utf8'));
const version = createHash("sha256").update(receiptBytes).update(serviceWorker).digest("hex");
const backendPolicy = await readFile(runtimeSourcePath('packages/runtime/toolchain-shims.js'));
if (runtimeBuild.source?.files?.find((file: { name: string }) => file.name === 'packages/runtime/toolchain-shims.js')?.sha256 !== sha256(backendPolicy)) throw Error('Backend policy differs from runtime build receipt');
await mkdir(destination, { recursive: true });
await writeFile(resolve(destination, 'backend-policy.mjs'), backendPolicy);
await cp(resolve(source, "assets"), resolve(destination, "assets"), { recursive: true });
await writeFile(resolve(destination, 'assets/sw.js'), serviceWorker);
await writeFile(resolve(destination, "distribution.json"), JSON.stringify({
  abi: "workspace-v2-sab6-sqlite39", features: ["install-tree-v1", "install-tree-image-v1", "http-stream-v1", "workspace-flush-v1"], name: "vivari", version, kernelWorker, serviceWorker: "assets/sw.js",
  runtimeBuild, runtimeBuildSha256: sha256(receiptBytes), topology,
  kernelSha256: createHash("sha256").update(kernelBytes).digest("hex"),
}, null, 2) + "\n");
console.log(JSON.stringify({ destination, version, kernelWorker }));
