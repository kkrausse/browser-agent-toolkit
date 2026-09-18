import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile as nodeWriteFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ManagedDelivery, ManagedEntry, SourceDelivery } from "./delivery-types.js";

export type BuildConfig = { outputDir: string; runtimeDir: string };

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

function inside(root: string, path: string) {
  const value = relative(root, path);
  return value === "" || (!value.startsWith(".." + sep) && value !== "..");
}

function relativeInput(path: string) {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")) throw Error(`Expected a safe relative path: ${path}`);
}

/** Remove and recreate one explicitly named build output directory. */
export async function resetDirectory(directory: string) {
  const target = resolve(directory);
  if (target === resolve(target, "/")) throw Error("Refusing to reset filesystem root");
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
}

/** Copy application-selected files immediately. No implicit include/exclude rules. */
export async function copyFiles(options: { sourceDir: string; destinationDir: string; paths: string[] }) {
  const source = resolve(options.sourceDir), destination = resolve(options.destinationDir);
  for (const name of options.paths) {
    relativeInput(name);
    const from = resolve(source, name), to = resolve(destination, name);
    if (!inside(source, from) || !inside(destination, to)) throw Error(`Copy path escapes its root: ${name}`);
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true, verbatimSymlinks: true, filter: path => ![".git", "node_modules"].includes(path.split(sep).at(-1)!) });
  }
}

/** Atomic file replacement for build manifests and receipts. */
export async function writeFile(path: string, data: string | Uint8Array) {
  const target = resolve(path), temporary = target + `.tmp-${process.pid}-${crypto.randomUUID()}`;
  await mkdir(dirname(target), { recursive: true });
  try { await nodeWriteFile(temporary, data); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
}

/** Run Bun's package installer now. Cache decisions belong in the calling build script. */
export async function installPackages(options: { directory: string; bunExecutable?: string; frozenLockfile?: boolean; cacheDir?: string; args?: string[] }) {
  const command = [options.bunExecutable ?? process.execPath, "install", "--linker", "isolated"];
  if (options.frozenLockfile ?? true) command.push("--frozen-lockfile");
  if (options.cacheDir) command.push("--cache-dir", resolve(options.cacheDir));
  command.push(...(options.args ?? []));
  const child = Bun.spawn(command, { cwd: resolve(options.directory), stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw Error(`Package installation failed with exit code ${exitCode}`);
}

/** Stable identity over caller-selected files and policy values. */
export async function fingerprint(options: { rootDir: string; files: string[]; values?: unknown }) {
  const root = resolve(options.rootDir), hash = createHash("sha256");
  hash.update(JSON.stringify(options.values ?? null));
  for (const name of [...new Set(options.files)].sort()) {
    relativeInput(name);
    const path = resolve(root, name);
    if (!inside(root, path)) throw Error(`Fingerprint path escapes root: ${name}`);
    const bytes = await readFile(path);
    hash.update(name).update("\0").update(String(bytes.length)).update("\0").update(bytes);
  }
  return hash.digest("hex");
}

export async function cacheMatches(options: { receiptPath: string; fingerprint: string; outputs: string[] }) {
  try {
    const receipt = JSON.parse(await readFile(resolve(options.receiptPath), "utf8"));
    if (receipt.format !== "build-cache-v1" || receipt.fingerprint !== options.fingerprint) return false;
    for (const output of options.outputs) await stat(resolve(output));
    return true;
  } catch { return false; }
}

/** Call only after all outputs have completed successfully. */
export async function markCache(options: { receiptPath: string; fingerprint: string; outputs: string[] }) {
  for (const output of options.outputs) await stat(resolve(output));
  await writeFile(options.receiptPath, JSON.stringify({ format: "build-cache-v1", fingerprint: options.fingerprint, outputs: options.outputs.map(output => resolve(output)) }, null, 2) + "\n");
}

function safeDestination(path: string) {
  if (!path.startsWith("/") || path === "/" || path.split("/").slice(1).some(part => !part || part === "." || part === ".." || /[\\\0]/.test(part))) throw Error(`Invalid managed destination: ${path}`);
}

/** Capture and gzip a directory immediately as one replaceable browser-managed tree. */
export async function bundleDirectory(options: { directory: string; outputDir: string; destination: string }): Promise<ManagedDelivery> {
  const source = resolve(options.directory), output = resolve(options.outputDir), destination = options.destination.replace(/\/$/, "");
  safeDestination(destination);
  const canonicalSource = await realpath(source);
  await mkdir(output, { recursive: true });
  const entries: ManagedEntry[] = [{ kind: "directory", destination, mode: (await stat(source)).mode & 0o777 }];
  const blobs = new Map<string, Uint8Array>();
  async function walk(directory: string, guest: string) {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, item.name), target = guest + "/" + item.name, metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        const link = await readlink(path);
        if (link.startsWith("/") || link.includes("\\") || link.includes("\0") || !inside(canonicalSource, await realpath(path))) throw Error(`Managed symlink must remain in its tree: ${relative(source, path)}`);
        entries.push({ kind: "symlink", destination: target, target: link });
      } else if (metadata.isDirectory()) {
        entries.push({ kind: "directory", destination: target, mode: metadata.mode & 0o777 });
        await walk(path, target);
      } else if (metadata.isFile()) {
        const bytes = new Uint8Array(await readFile(path)), digest = sha256(bytes), file = digest + ".bin";
        entries.push({ kind: "file", destination: target, mode: metadata.mode & 0o777, file, bytes: bytes.length, sha256: digest });
        blobs.set(file, bytes);
      }
    }
  }
  await walk(source, destination);
  const chunks = [...new Set(entries.flatMap(entry => entry.kind === "file" ? [entry.file] : []))].map(file => blobs.get(file)!);
  const packed = new Uint8Array(Buffer.concat(chunks.map(bytes => Buffer.from(bytes)))), compressed = Bun.gzipSync(packed), digest = sha256(compressed);
  const bundle = { file: digest + ".bundle.gz", bytes: compressed.length, sha256: digest };
  await writeFile(join(output, bundle.file), compressed);
  return { format: "managed-tree-v1", roots: [destination], entries, bundle };
}

/** Bundle already content-addressed managed entries without recapturing their tree. */
export async function bundleEntries(options: { entries: ManagedEntry[]; assetDir: string; outputDir?: string }) {
  const seen = new Set<string>(), chunks: Uint8Array[] = [];
  for (const entry of options.entries) if (entry.kind === "file" && !seen.has(entry.file)) {
    seen.add(entry.file);
    const bytes = new Uint8Array(await readFile(resolve(options.assetDir, entry.file)));
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw Error(`Managed asset differs from its entry: ${entry.destination}`);
    chunks.push(bytes);
  }
  const packed = new Uint8Array(Buffer.concat(chunks.map(bytes => Buffer.from(bytes)))), compressed = Bun.gzipSync(packed), digest = sha256(compressed);
  const bundle = { file: digest + ".bundle.gz", bytes: compressed.length, sha256: digest };
  await writeFile(join(resolve(options.outputDir ?? options.assetDir), bundle.file), compressed);
  return bundle;
}

export async function captureSource(options: { rootDir: string; paths: string[] }): Promise<SourceDelivery> {
  const root = resolve(options.rootDir), result: SourceDelivery = {};
  const canonicalRoot = await realpath(root);
  async function visit(path: string, name: string, ancestors = new Set<string>()) {
    const canonical = await realpath(path);
    if (!inside(canonicalRoot, canonical)) throw Error(`Source path escapes its root: ${name}`);
    const metadata = await stat(canonical);
    if (metadata.isDirectory()) {
      if (ancestors.has(canonical)) throw Error(`Cyclic source directory: ${name}`);
      const next = new Set(ancestors).add(canonical);
      for (const entry of (await readdir(canonical)).sort()) await visit(join(canonical, entry), name + "/" + entry, next);
    }
    else {
      const bytes = new Uint8Array(await readFile(canonical));
      let utf8 = new TextDecoder("utf-8", { fatal: true });
      try { result["/" + name] = utf8.decode(bytes); }
      catch { result["/" + name] = { encoding: "base64", data: Buffer.from(bytes).toString("base64") }; }
    }
  }
  for (const name of options.paths) { relativeInput(name); await visit(resolve(root, name), name); }
  return result;
}
