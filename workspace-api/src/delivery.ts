import type { ToolDescriptor, Workspace } from "./index.js";
import type { ManagedDelivery, ManagedEntry, SourceDelivery } from "./delivery-types.js";
import { environmentExperimentKey, reusableEnvironmentExperiment, type EnvironmentExperimentResult } from "./environment-experiment.js";

const sha256 = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)))].map(value => value.toString(16).padStart(2, "0")).join("");

function validate(delivery: ManagedDelivery) {
  if (delivery.format !== "managed-tree-v1" || !delivery.roots.length) throw Error("Invalid managed delivery");
  const paths = new Map<string, ManagedEntry>();
  const rootFor = (path: string) => delivery.roots.find(root => path === root || path.startsWith(root + "/"));
  const unsafePath = (path: string) => !path.startsWith("/") || path.split("/").slice(1).some(part => !part || part === "." || part === ".." || /[\\\0]/.test(part));
  for (const root of delivery.roots) if (root === "/" || unsafePath(root) || delivery.roots.some(other => other !== root && root.startsWith(other + "/"))) throw Error("Invalid managed root");
  for (const entry of delivery.entries) {
    if (unsafePath(entry.destination) || !rootFor(entry.destination) || paths.has(entry.destination)) throw Error("Managed entry escapes its roots");
    paths.set(entry.destination, entry);
    if (entry.kind === "file" && (entry.file !== entry.sha256 + ".bin" || !/^[a-f0-9]{64}$/.test(entry.sha256))) throw Error("Invalid managed file");
    if (entry.kind === "symlink" && (entry.target.startsWith("/") || /[\\\0]/.test(entry.target))) throw Error("Invalid managed symlink");
  }
  for (const entry of delivery.entries) {
    if (!delivery.roots.includes(entry.destination)) {
      const parent = entry.destination.slice(0, entry.destination.lastIndexOf("/"));
      if (paths.get(parent)?.kind !== "directory") throw Error("Managed entry parent must be a directory");
    }
  }
  function follow(path: string, visited: Set<string>): string {
    const parts = path.split("/").slice(1), resolved: string[] = [];
    let enteredRoot = false;
    while (parts.length) {
      const part = parts.shift()!;
      if (part === "." || !part) continue;
      if (part === "..") {
        resolved.pop();
        if (enteredRoot && !rootFor("/" + resolved.join("/"))) throw Error("Managed symlink escapes its root");
        continue;
      }
      resolved.push(part);
      const current = "/" + resolved.join("/");
      if (rootFor(current)) enteredRoot = true;
      const entry = paths.get(current);
      if (entry?.kind === "symlink") {
        if (visited.has(current)) throw Error("Cyclic managed symlink");
        const target = follow(current.slice(0, current.lastIndexOf("/")) + "/" + entry.target, new Set(visited).add(current));
        resolved.splice(0, resolved.length, ...target.split("/").slice(1));
      }
      if (enteredRoot && parts.length && paths.get("/" + resolved.join("/"))?.kind !== "directory") throw Error("Invalid managed symlink parent");
    }
    const result = "/" + resolved.join("/");
    if (!paths.has(result)) throw Error("Dangling managed symlink");
    return result;
  }
  for (const entry of delivery.entries) if (entry.kind === "symlink" && rootFor(follow(entry.destination, new Set())) !== rootFor(entry.destination)) throw Error("Managed symlink escapes its root");
}

/** Replace only declared managed roots. Persistent workspace source is untouched. */
export function managedDeliveryTool(delivery: ManagedDelivery, options: {
  baseUrl: string; signal: AbortSignal; report?(message: string): void;
  /** Experimental: verify the complete installed tree before skipping download/decode/install. */
  experimentalReuseInstalled?: { runtimeVersion: string; disposablePaths?: string[]; onResult?(result: EnvironmentExperimentResult): void };
}): ToolDescriptor<void, void> {
  validate(delivery);
  const tool: ToolDescriptor<void, void> = { name: "managed-tree", version: delivery.bundle.sha256, async bind(context) { return async () => {
    const selected = context.installTreeImage && delivery.image ? delivery.image : delivery.bundle;
    const url = options.baseUrl + selected.file;
    const valid = async (bytes: Uint8Array) => bytes.length === selected.bytes && await sha256(bytes) === selected.sha256;
    let cache: Cache | undefined, compressed: Uint8Array | undefined;
    try {
      if (typeof caches !== "undefined") {
        cache = await caches.open("workspace-managed-deliveries-v1");
        const cached = await cache.match(url);
        if (cached) {
          const bytes = new Uint8Array(await cached.arrayBuffer());
          if (await valid(bytes)) compressed = bytes;
          else await cache.delete(url);
        }
      }
    } catch { /* CacheStorage is only an optimization. */ }
    if (compressed) options.report?.(`Using cached managed dependency/tool ${selected === delivery.image ? "image" : "bundle"}`);
    else {
      options.report?.(`Downloading managed dependency/tool ${selected === delivery.image ? "image" : "bundle"}…`);
      const response = await fetch(url, { signal: options.signal });
      if (!response.ok) throw Error(`Managed bundle HTTP ${response.status}`);
      compressed = new Uint8Array(await response.arrayBuffer());
      if (!await valid(compressed)) throw Error("Managed bundle integrity failure");
      try { await cache?.put(url, new Response(Uint8Array.from(compressed))); } catch { /* verified bytes remain usable */ }
    }
    const packed = new Uint8Array(await new Response(new Blob([Uint8Array.from(compressed)]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    if (selected === delivery.image) {
      if (packed.length < 4) throw Error("Managed image header is truncated");
      const headerBytes = new DataView(packed.buffer, packed.byteOffset, packed.byteLength).getUint32(0, true);
      if (!headerBytes || headerBytes > packed.length - 4) throw Error("Managed image header is invalid");
      let header: { v?: unknown; codec?: unknown; bodies?: unknown };
      try { header = JSON.parse(new TextDecoder().decode(packed.subarray(4, 4 + headerBytes))) as typeof header; }
      catch { throw Error("Managed image header is invalid"); }
      if (header.v !== 1 || header.codec !== "vfs-zlib-6-v1" || !Array.isArray(header.bodies)) throw Error("Unsupported managed image");
      const uniqueFiles = [...new Map(delivery.entries.flatMap(entry => entry.kind === "file" ? [[entry.file, entry] as const] : [])).values()];
      if (header.bodies.length !== uniqueFiles.length) throw Error("Managed image body count mismatch");
      const blobs = new Map<string, { bytes: Uint8Array; encoding: 0 | 1 }>();
      let offset = 4 + headerBytes;
      for (let index = 0; index < uniqueFiles.length; index++) {
        const entry = uniqueFiles[index]!, body = header.bodies[index];
        if (!Array.isArray(body) || body.length !== 2 || (body[0] !== 0 && body[0] !== 1)
          || !Number.isSafeInteger(body[1]) || body[1] < 0 || offset + body[1] > packed.length) throw Error("Managed image body metadata is invalid");
        const encoding = body[0] as 0 | 1, bytes = body[1] as number;
        if ((encoding === 0 && bytes !== entry.bytes) || (encoding === 1 && (entry.bytes < 4096 || bytes >= entry.bytes * 0.95))) throw Error("Managed image body violates VFS policy");
        blobs.set(entry.file, { bytes: packed.subarray(offset, offset + bytes), encoding });
        offset += bytes;
      }
      if (offset !== packed.length) throw Error("Managed image size mismatch");
      options.signal.throwIfAborted();
      await context.installTreeImage!({ roots: delivery.roots, entries: delivery.entries.map(entry => entry.kind === "file"
        ? { kind: "file", path: entry.destination, mode: entry.mode, bytes: blobs.get(entry.file)!.bytes, logicalBytes: entry.bytes, encoding: blobs.get(entry.file)!.encoding, sha256: entry.sha256 }
        : entry.kind === "directory" ? { kind: "directory", path: entry.destination, mode: entry.mode }
          : { kind: "symlink", path: entry.destination, target: entry.target }) });
      return;
    }
    const blobs = new Map<string, Uint8Array>(); let offset = 0;
    for (const entry of delivery.entries) if (entry.kind === "file" && !blobs.has(entry.file)) { blobs.set(entry.file, packed.subarray(offset, offset + entry.bytes)); offset += entry.bytes; }
    if (offset !== packed.length) throw Error("Managed bundle size mismatch");
    options.signal.throwIfAborted();
    await context.installTree({ roots: delivery.roots, entries: delivery.entries.map(entry => entry.kind === "file"
      ? { kind: "file", path: entry.destination, mode: entry.mode, bytes: blobs.get(entry.file)!, sha256: entry.sha256 }
      : entry.kind === "directory" ? { kind: "directory", path: entry.destination, mode: entry.mode }
        : { kind: "symlink", path: entry.destination, target: entry.target }) });
  }; } };
  const reuse = options.experimentalReuseInstalled;
  if (!reuse) return tool;
  return { name: tool.name, version: tool.version, async bind(context) {
    const key = await environmentExperimentKey({ runtimeVersion: reuse.runtimeVersion, bundleSha256: delivery.bundle.sha256, imageSha256: delivery.image?.sha256, entries: delivery.entries, roots: delivery.roots });
    return reusableEnvironmentExperiment({ delivery: tool, key, entries: delivery.entries, roots: delivery.roots, disposablePaths: reuse.disposablePaths, report(result) {
      reuse.onResult?.(result);
      options.report?.(result.reused ? "Reusing verified installed dependency/tool environment" : `Installed environment miss: ${result.reason}`);
    } }).bind(context);
  } };
}

/** Source retention is an explicit application choice at install time. */
export async function installSource(workspace: Workspace, source: SourceDelivery, options: { existing: "preserve" | "replace" }) {
  for (const [path, file] of Object.entries(source).sort(([a], [b]) => a.localeCompare(b))) {
    if (!path.startsWith("/") || path.split("/").slice(1).some(part => !part || part === "." || part === "..")) throw Error(`Invalid source path: ${path}`);
    if (options.existing === "preserve") { try { await workspace.fs.stat(path); continue; } catch { /* missing */ } }
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    await workspace.fs.mkdir(parent);
    const bytes = typeof file === "string" ? new TextEncoder().encode(file) : Uint8Array.from(atob(file.data), character => character.charCodeAt(0));
    await workspace.fs.writeFile(path, bytes);
  }
}

export type { ManagedDelivery, ManagedEntry, ManagedBundle, ManagedVfsImage, SourceDelivery, SourceFile } from "./delivery-types.js";
export { experimentalSourceReplacementTool } from "./environment-experiment.js";
