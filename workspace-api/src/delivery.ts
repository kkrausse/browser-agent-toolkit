import type { ToolDescriptor, Workspace } from "./index.js";
import type { ManagedDelivery, ManagedEntry, SourceDelivery } from "./delivery-types.js";

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
export function managedDeliveryTool(delivery: ManagedDelivery, options: { baseUrl: string; signal: AbortSignal; report?(message: string): void }): ToolDescriptor<void, void> {
  validate(delivery);
  return { name: "managed-tree", version: delivery.bundle.sha256, async bind(context) { return async () => {
    const url = options.baseUrl + delivery.bundle.file;
    const valid = async (bytes: Uint8Array) => bytes.length === delivery.bundle.bytes && await sha256(bytes) === delivery.bundle.sha256;
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
    if (compressed) options.report?.("Using cached managed dependency/tool bundle");
    else {
      options.report?.("Downloading managed dependency/tool bundle…");
      const response = await fetch(url, { signal: options.signal });
      if (!response.ok) throw Error(`Managed bundle HTTP ${response.status}`);
      compressed = new Uint8Array(await response.arrayBuffer());
      if (!await valid(compressed)) throw Error("Managed bundle integrity failure");
      try { await cache?.put(url, new Response(Uint8Array.from(compressed))); } catch { /* verified bytes remain usable */ }
    }
    const packed = new Uint8Array(await new Response(new Blob([Uint8Array.from(compressed)]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    const blobs = new Map<string, Uint8Array>(); let offset = 0;
    for (const entry of delivery.entries) if (entry.kind === "file" && !blobs.has(entry.file)) { blobs.set(entry.file, packed.subarray(offset, offset + entry.bytes)); offset += entry.bytes; }
    if (offset !== packed.length) throw Error("Managed bundle size mismatch");
    options.signal.throwIfAborted();
    await context.installTree({ roots: delivery.roots, entries: delivery.entries.map(entry => entry.kind === "file"
      ? { kind: "file", path: entry.destination, mode: entry.mode, bytes: blobs.get(entry.file)!, sha256: entry.sha256 }
      : entry.kind === "directory" ? { kind: "directory", path: entry.destination, mode: entry.mode }
        : { kind: "symlink", path: entry.destination, target: entry.target }) });
  }; } };
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

export type { ManagedDelivery, ManagedEntry, ManagedBundle, SourceDelivery, SourceFile } from "./delivery-types.js";
