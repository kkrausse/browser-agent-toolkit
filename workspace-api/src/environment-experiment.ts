import type { Execution, ToolContext, ToolDescriptor } from "./types.js"
import type { ManagedEntry, SourceDelivery } from "./delivery-types.js"

// Opt-in experiments. Normal delivery and consumers remain unchanged.
export const ENVIRONMENT_RECEIPT = "/workspace/.browser-editor-cache/environment-experiment.json"

/** A failed ownership proof forbids fallback or any subsequent workspace mutation. */
export class EnvironmentOwnershipError extends Error {
  readonly code = "ENVIRONMENT_OWNERSHIP_UNPROVEN"
  constructor(message: string, readonly failures: unknown[]) {
    super(message, { cause: failures[0] })
    this.name = "EnvironmentOwnershipError"
  }
}

async function runEnvironmentScript(context: ToolContext, script: string, consumerSignal?: AbortSignal): Promise<string> {
  consumerSignal?.throwIfAborted()
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000), ...(consumerSignal ? [consumerSignal] : [])])
  const bytes = new TextEncoder().encode(script)
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("")
  const path = `/workspace/.browser-editor-cache/experiments/${hash}.cjs`
  // installFile deliberately rejects conflicting writes; scripts are immutable.
  await context.installFile(path, bytes)
  signal.throwIfAborted()
  // A rejected launch offers no Execution with which to prove cleanup.
  let execution: Execution
  try { execution = await context.node({ entry: path, cwd: "/workspace", signal }) } catch (error) {
    throw new EnvironmentOwnershipError("Environment launch ownership unproven", [error])
  }
  const drain = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
    let text = ""
    let bytes = 0
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      bytes += chunk.byteLength
      if (bytes > 4 * 1024 * 1024) {
        const error = new Error("Environment output limit exceeded")
        controller.abort(error)
        throw error
      }
      text += decoder.decode(chunk, {stream: true})
    }
    return text + decoder.decode()
  }
  // Defer property access too: an Execution getter may throw synchronously.
  const tasks = [Promise.resolve().then(() => drain(execution.stdout)), Promise.resolve().then(() => drain(execution.stderr)), Promise.resolve().then(() => execution.exited)] as const
  let stop: Promise<void> | undefined
  const requestStop = () => stop ??= Promise.resolve().then(() => execution.stop())
  // Attach a rejection observer immediately; still inspect the stop result below.
  const stopNow = () => { void requestStop().catch(() => {}) }
  signal.addEventListener("abort", stopNow, { once: true })
  if (signal.aborted) stopNow()
  for (const task of tasks) void task.catch(error => { controller.abort(error); stopNow() })
  let closeFailure: unknown
  let closeFailed = false
  try { execution.closeStdin() } catch (error) { closeFailed = true; closeFailure = error; controller.abort(error); stopNow() }
  // allSettled never releases ownership on the first reader/exit rejection.
  const joined = await Promise.allSettled(tasks)
  const stopped = await Promise.allSettled([requestStop()])
  signal.removeEventListener("abort", stopNow)
  const failures = [...joined, ...stopped].flatMap(result => result.status === "rejected" ? [result.reason] : [])
  if (closeFailed) failures.push(closeFailure)
  if (failures.length) throw new EnvironmentOwnershipError("Environment output/exit/stop ownership unproven", failures)
  signal.throwIfAborted()
  const [stdout, stderr, exit] = joined as [PromiseFulfilledResult<string>, PromiseFulfilledResult<string>, PromiseFulfilledResult<Awaited<typeof execution.exited>>]
  if (exit.value.exitCode !== 0 || exit.value.signal !== null || exit.value.forced) throw new Error(`Environment experiment process failed: ${stderr.value.slice(0, 1000)}`)
  return stdout.value
}

export type EnvironmentExperimentResult = {
  reused: boolean
  reason: string
  verificationMs: number
  audit?: InstalledEnvironmentAuditResult
}

export async function environmentExperimentKey(input: {
  runtimeVersion: string
  bundleSha256: string
  imageSha256?: string
  entries: ManagedEntry[]
  roots: string[]
}): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([1, input.runtimeVersion, input.bundleSha256, input.imageSha256 ?? null, input.roots, input.entries]))
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

/** Explicit cache roots only; this is not permission to ignore installed subtrees. */
export interface InstalledCachePolicy {
  paths: string[]
  maxEntries?: number
  maxFileBytes?: number
  maxTotalBytes?: number
  maxDepth?: number
}
export type InstalledCacheEntry =
  | { path: string; kind: "absent" }
  | { path: string; kind: "directory"; mode: number }
  | { path: string; kind: "file"; mode: number; bytes: number; sha256: string }
export type InstalledEnvironmentAuditResult =
  | { valid: true; checked: number; inventory: InstalledCacheEntry[]; cacheDigest: string; cacheBytes: number }
  | { valid: false; checked: number; reason: string }

function parseInstalledEnvironmentAudit(stdout: string, expectedChecked: number): InstalledEnvironmentAuditResult {
  const result = JSON.parse(stdout.trim()) as InstalledEnvironmentAuditResult
  if (!result || !Number.isSafeInteger(result.checked) || result.checked < 0 || result.checked > expectedChecked) throw new Error("Invalid installed audit result")
  if (result.valid === false && typeof result.reason === "string") return result
  if (result.valid !== true || result.checked !== expectedChecked || !Array.isArray(result.inventory) || result.inventory.length > 10000
    || !/^[a-f0-9]{64}$/.test(result.cacheDigest) || !Number.isSafeInteger(result.cacheBytes) || result.cacheBytes < 0 || result.cacheBytes > 64 * 1024 * 1024) throw new Error("Invalid installed audit result")
  for (const entry of result.inventory) {
    if (!entry || typeof entry.path !== "string" || !entry.path.startsWith("/")) throw new Error("Invalid installed cache inventory")
    if (entry.kind === "absent") continue
    if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 511) throw new Error("Invalid installed cache inventory")
    if (entry.kind === "directory") continue
    if (entry.kind !== "file" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 16 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Invalid installed cache inventory")
  }
  return result
}

/** Read-only audit for a stopped, exclusively owned tree. No receipt shortcut.
 * Supply entries/roots from an already provenance-validated managed delivery.
 * Cache digest includes absence, paths, modes, sizes and file hashes in sorted order.
 * Compare successful before/after digests around source replacement. The caller owns
 * service shutdown and exclusivity; lstat is not protection against concurrent writers.
 */
export function installedEnvironmentAuditScript(entries: ManagedEntry[], roots: string[], policy: InstalledCachePolicy): string {
  const safe = (path: string) => path.startsWith("/") && path !== "/" && !path.split("/").slice(1).some(part => !part || part === "." || part === ".." || /[\\\0]/.test(part))
  if (!roots.length || roots.some(root => !safe(root) || roots.some(other => other !== root && root.startsWith(other + "/")))
    || new Set(roots).size !== roots.length
    || entries.some(entry => !safe(entry.destination) || !roots.some(root => entry.destination === root || entry.destination.startsWith(root + "/")))
    || new Set(entries.map(entry => entry.destination)).size !== entries.length) throw new Error("Unsafe installed audit path")
  const manifest = new Map(entries.map(entry => [entry.destination, entry]))
  for (const entry of entries) if (!roots.includes(entry.destination) && manifest.get(entry.destination.slice(0, entry.destination.lastIndexOf("/")))?.kind !== "directory") throw new Error("Unsafe installed audit parent")
  const paths = [...policy.paths].sort()
  for (const path of paths) {
    if (!safe(path) || !(roots.some(root => path.startsWith(root + "/")) || path === "/workspace/.browser-editor-cache/vite")
      || paths.some(other => other !== path && path.startsWith(other + "/"))
      || paths.indexOf(path) !== paths.lastIndexOf(path)
      || entries.some(entry => entry.destination === path || entry.destination.startsWith(path + "/") || (path.startsWith(entry.destination + "/") && entry.kind !== "directory"))) throw new Error(`Unsafe installed cache policy: ${path}`)
  }
  const limits = { maxEntries: policy.maxEntries ?? 10000, maxFileBytes: policy.maxFileBytes ?? 16 * 1024 * 1024, maxTotalBytes: policy.maxTotalBytes ?? 64 * 1024 * 1024, maxDepth: policy.maxDepth ?? 32 }
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > ({ maxEntries: 10000, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, maxDepth: 32 }[name as keyof typeof limits])) throw new Error(`Invalid audit limit: ${name}`)
  return `
const fs = require('node:fs'), crypto = require('node:crypto');
const entries = ${JSON.stringify(entries)}, roots = ${JSON.stringify(roots)}, caches = ${JSON.stringify(paths)}, limits = ${JSON.stringify(limits)};
const expected = new Map(entries.map(entry => [entry.destination, entry]));
const inventory = []; let checked = 0, cacheBytes = 0;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function statOrAbsent(path) { try { return fs.lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function parents(path) {
  let parent = '';
  for (const part of path.split('/').slice(1, -1)) {
    parent += '/' + part;
    const stat = statOrAbsent(parent);
    if (!stat) return false;
    if (!stat.isDirectory()) throw Error('unsafe audit ancestor: ' + parent);
  }
  return true;
}
function record(entry) { if (inventory.length >= limits.maxEntries) throw Error('cache entry limit'); inventory.push(entry); }
function children(path) {
  const names = fs.readdirSync(path);
  for (const name of names) if (!name || name === '.' || name === '..' || name.includes('/') || name.includes(String.fromCharCode(92)) || name.includes(String.fromCharCode(0))) throw Error('unsafe audit child: ' + path);
  return names.sort();
}
function cache(path, depth) {
  if (depth > limits.maxDepth) throw Error('cache depth limit');
  const stat = fs.lstatSync(path);
  if (depth === 0 && !stat.isDirectory()) throw Error('cache root is not directory: ' + path);
  if (stat.isSymbolicLink()) throw Error('cache symlink: ' + path);
  if (stat.isDirectory()) {
    record({path, kind:'directory', mode:stat.mode & 511});
    const names = children(path);
    if (names.length > limits.maxEntries - inventory.length) throw Error('cache entry limit');
    for (const name of names) cache(path + '/' + name, depth + 1);
  } else if (stat.isFile()) {
    if (stat.size > limits.maxFileBytes || stat.size > limits.maxTotalBytes - cacheBytes) throw Error('cache byte limit');
    const bytes = fs.readFileSync(path);
    if (bytes.length !== stat.size) throw Error('cache changed during audit: ' + path);
    cacheBytes += bytes.length;
    record({path, kind:'file', mode:stat.mode & 511, bytes:stat.size, sha256:hash(bytes)});
  } else throw Error('unexpected cache kind: ' + path);
}
function inspect(path) {
  if (caches.includes(path)) return; // audited separately, never ignored
  const entry = expected.get(path); if (!entry) throw Error('unexpected installed path: ' + path);
  const stat = fs.lstatSync(path);
  if (entry.kind !== 'symlink' && (stat.mode & 511) !== entry.mode) throw Error('mode mismatch: ' + path);
  if (entry.kind === 'directory') {
    if (!stat.isDirectory()) throw Error('not a directory: ' + path);
    const names = children(path);
    if (names.length > entries.length + caches.length) throw Error('installed entry limit');
    for (const name of names) inspect(path + '/' + name);
  } else if (entry.kind === 'symlink') {
    if (!stat.isSymbolicLink() || fs.readlinkSync(path) !== entry.target) throw Error('symlink mismatch: ' + path);
  } else if (!stat.isFile() || stat.size !== entry.bytes || hash(fs.readFileSync(path)) !== entry.sha256) throw Error('content mismatch: ' + path);
  checked++;
}
try {
  for (const root of roots) {
    const exists = parents(root) && statOrAbsent(root);
    if (expected.has(root)) { if (!exists) throw Error('missing installed root: ' + root); inspect(root); }
    else if (exists && (!exists.isDirectory() || fs.readdirSync(root).length)) throw Error('unexpected installed root: ' + root);
  }
  if (checked !== entries.length || expected.size !== entries.length) throw Error('missing or duplicate installed entries');
  for (const path of caches) {
    if (parents(path) && statOrAbsent(path)) cache(path, 0);
    else record({path, kind:'absent'});
  }
  console.log(JSON.stringify({valid:true, checked, inventory, cacheDigest:hash(JSON.stringify(inventory)), cacheBytes}));
} catch (error) { console.log(JSON.stringify({valid:false, checked, reason:error.message})); }
`
}

/** Requires caller-attested, joined shutdown on EVERY invocation, not just bind. */
export function experimentalInstalledEnvironmentAuditTool(entries: ManagedEntry[], roots: string[], policy: InstalledCachePolicy): ToolDescriptor<{ servicesStopped: true; signal?: AbortSignal }, InstalledEnvironmentAuditResult> {
  const script = installedEnvironmentAuditScript(entries, roots, policy)
  return { name: "installed-environment-audit", version: "experiment-v1", async bind(context) {
    return async options => {
      if (options.servicesStopped !== true) throw new Error("Stopped services required")
      return parseInstalledEnvironmentAudit(await runEnvironmentScript(context, script, options.signal), entries.length)
    }
  } }
}

// Only used after a joined miss, with the same already-validated explicit policy.
// External caches must not survive conservative redelivery of managed roots.
function installedCacheResetScript(policy: InstalledCachePolicy): string {
  return `
const fs = require('node:fs');
for (const path of ${JSON.stringify(policy.paths)}) {
  let parent = '', missing = false;
  for (const part of path.split('/').slice(1, -1)) {
    parent += '/' + part;
    try { if (!fs.lstatSync(parent).isDirectory()) throw Error('unsafe cache reset ancestor: ' + parent); }
    catch (error) { if (error.code !== 'ENOENT') throw error; missing = true; break; }
  }
  if (!missing) fs.rmSync(path, {recursive:true, force:true});
}
`
}

// Use lstat/readlink rather than following symlinks into outgoing workspace state.
// A receipt alone is not proof of integrity: agents can modify installed packages.
export function environmentVerificationScript(entries: ManagedEntry[], roots: string[], disposablePaths: string[] = []): string {
  for (const path of disposablePaths) {
    if (!roots.some(root => path.startsWith(root + "/")) || path.split("/").slice(1).some(part => !part || part === ".." || part === "." || /[\\\0]/.test(part)) || entries.some(entry => entry.destination === path || entry.destination.startsWith(path + "/"))) {
      throw new Error(`Invalid disposable installed cache: ${path}`)
    }
  }
  return `
const fs = require('node:fs');
const crypto = require('node:crypto');
const entries = ${JSON.stringify(entries)};
const roots = ${JSON.stringify(roots)};
const expected = new Map(entries.map(entry => [entry.destination, entry]));
// A tampered ancestor must not redirect cache cleanup outside managed roots.
for (const path of ${JSON.stringify(disposablePaths)}) {
  const parts = path.split('/').slice(1, -1);
  let parent = '';
  for (const part of parts) {
    parent += '/' + part;
    if (!fs.lstatSync(parent).isDirectory()) throw new Error('unsafe cache parent: ' + parent);
  }
  fs.rmSync(path, {recursive: true, force: true});
}
let checked = 0;
function inspect(path) {
  const entry = expected.get(path);
  if (!entry) throw new Error('unexpected installed path: ' + path);
  const stat = fs.lstatSync(path);
  if (entry.kind !== 'symlink' && (stat.mode & 511) !== entry.mode) throw new Error('mode mismatch: ' + path);
  if (entry.kind === 'directory') {
    if (!stat.isDirectory()) throw new Error('not a directory: ' + path);
    for (const name of fs.readdirSync(path)) inspect(path + '/' + name);
  } else if (entry.kind === 'symlink') {
    if (!stat.isSymbolicLink() || fs.readlinkSync(path) !== entry.target) throw new Error('symlink mismatch: ' + path);
  } else {
    if (!stat.isFile() || stat.size !== entry.bytes || crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex') !== entry.sha256) throw new Error('content mismatch: ' + path);
  }
  checked++;
}
try {
  for (const root of roots) {
    if (expected.has(root)) inspect(root);
    else if (fs.existsSync(root) && (!fs.lstatSync(root).isDirectory() || fs.readdirSync(root).length)) throw new Error('unexpected installed root: ' + root);
  }
  if (checked !== entries.length) throw new Error('missing installed entries');
  console.log(JSON.stringify({valid: true, checked}));
} catch (error) {
  console.log(JSON.stringify({valid: false, reason: error.message}));
}
`
}

export function reusableEnvironmentExperiment(options: {
  delivery: ToolDescriptor<void, void>
  key: string
  entries: ManagedEntry[]
  roots: string[]
  disposablePaths?: string[]
  signal?: AbortSignal
  /** Caller must have stopped and joined every service/reader before opting in. */
  preserveCaches?: { servicesStopped: true; policy: InstalledCachePolicy }
  report(result: EnvironmentExperimentResult): void
}): ToolDescriptor<void, void> {
  if (options.preserveCaches && (options.preserveCaches.servicesStopped !== true || options.disposablePaths?.length)) throw new Error("Preserved caches require stopped services and no disposable paths")
  const verificationScript = options.preserveCaches
    ? installedEnvironmentAuditScript(options.entries, options.roots, options.preserveCaches.policy)
    : environmentVerificationScript(options.entries, options.roots, options.disposablePaths)
  // Freeze the validated cleanup scope before any await/caller mutation.
  const cacheResetScript = options.preserveCaches ? installedCacheResetScript(options.preserveCaches.policy) : undefined
  return {
    name: options.delivery.name,
    version: options.delivery.version,
    async bind(context) {
      // Preserve the toolkit's manifest/receipt validation even on a reuse hit.
      const deliver = await options.delivery.bind(context)
      return async () => {
        options.signal?.throwIfAborted()
        const started = performance.now()
        let reason = "no matching installed receipt"
        try {
          const receipt = new TextDecoder().decode(await context.readFile(ENVIRONMENT_RECEIPT))
          if (receipt === options.key) {
            const stdout = await runEnvironmentScript(context, verificationScript, options.signal)
            const result = options.preserveCaches ? parseInstalledEnvironmentAudit(stdout, options.entries.length) : JSON.parse(stdout.trim()) as { valid?: boolean; reason?: string }
            if (result.valid === true) {
              options.report({ reused: true, reason: "all installed paths, symlinks and content verified", verificationMs: performance.now() - started, ...(options.preserveCaches ? { audit: result as InstalledEnvironmentAuditResult } : {}) })
              return
            }
            reason = result.reason ?? "installed verification failed"
          }
        } catch (error) {
          if (error instanceof EnvironmentOwnershipError || options.signal?.aborted || (error instanceof DOMException && error.name === "TimeoutError")) throw error
          reason = error instanceof Error ? error.message : String(error)
        }
        options.report({ reused: false, reason, verificationMs: performance.now() - started })
        // Invalidate before installation: partial writes must never leave a valid receipt.
        options.signal?.throwIfAborted()
        const writeReceipt = (value: string): Promise<string> => runEnvironmentScript(context, `
const fs = require('node:fs'), receipt = ${JSON.stringify(ENVIRONMENT_RECEIPT)};
for (const parent of ['/workspace', '/workspace/.browser-editor-cache']) if (!fs.lstatSync(parent).isDirectory()) throw Error('unsafe receipt ancestor: ' + parent);
try { if (!fs.lstatSync(receipt).isFile()) throw Error('unsafe environment receipt'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
fs.writeFileSync(receipt, ${JSON.stringify(value)});
`, options.signal)
        await writeReceipt("")
        if (cacheResetScript) await runEnvironmentScript(context, cacheResetScript, options.signal)
        options.signal?.throwIfAborted()
        await deliver()
        options.signal?.throwIfAborted()
        await writeReceipt(options.key)
      }
    },
  }
}

export function sourceReplacementScript(source: SourceDelivery, incremental: boolean): string {
  // The fixture owns /workspace except two managed roots and the experiment cache.
  // This is deliberately not a public arbitrary-workspace cleanup API.
  for (const path of Object.keys(source)) {
    if (!path.startsWith("/") || path.split("/").slice(1).some(part => !part || part === "." || part === ".." || /[\\\0]/.test(part))) {
      throw new Error(`Unsafe fixture path: ${path}`)
    }
    if (["node_modules", ".browser-editor-backends", ".browser-editor-cache"].includes(path.split("/")[1]!)) {
      throw new Error(`Fixture overlaps managed state: ${path}`)
    }
  }
  const paths = new Set(Object.keys(source))
  for (const path of paths) {
    const parts = path.split("/").slice(1, -1)
    for (let index = 1; index <= parts.length; index++) {
      if (paths.has("/" + parts.slice(0, index).join("/"))) throw new Error(`Source file is also a directory: ${path}`)
    }
  }
  return `
const fs = require('node:fs');
const path = require('node:path');
const source = ${JSON.stringify(source)};
const incremental = ${JSON.stringify(incremental)};
const keep = new Set(['node_modules', '.browser-editor-backends', '.browser-editor-cache']);
const wanted = new Map(Object.entries(source).map(([name, file]) => ['/workspace' + name, typeof file === 'string' ? Buffer.from(file) : Buffer.from(file.data, 'base64')]));
const dirs = new Set(['/workspace']);
for (const name of wanted.keys()) for (let dir = path.dirname(name); dir !== '/workspace'; dir = path.dirname(dir)) dirs.add(dir);
let writes = 0, deletes = 0, unchanged = 0;
function clean(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (dir === '/workspace' && keep.has(name)) continue;
    const target = dir + '/' + name;
    const stat = fs.lstatSync(target);
    if (incremental && stat.isDirectory() && dirs.has(target)) clean(target);
    else if (incremental && stat.isFile() && wanted.has(target)) continue;
    else { fs.rmSync(target, {recursive: true, force: true}); deletes++; }
  }
}
clean('/workspace');
// Reset project-local runtime configuration, never the managed tool roots.
fs.rmSync('/.server', {recursive: true, force: true});
for (const [name, bytes] of wanted) {
  if (incremental && fs.existsSync(name) && fs.lstatSync(name).isFile() && fs.readFileSync(name).equals(bytes)) { unchanged++; continue; }
  fs.mkdirSync(path.dirname(name), {recursive: true});
  fs.writeFileSync(name, bytes); writes++;
}
console.log(JSON.stringify({writes, deletes, unchanged}));
`
}

/** Experimental exact source replacement; stop/drain ALL previous readers first.
 * Keeps only managed dependencies/backends and the toolkit experiment cache.
 * Partial failure is not transactional: callers retain the validated target for retry.
 */
export function experimentalSourceReplacementTool(source: SourceDelivery, options: { incremental?: boolean; signal?: AbortSignal } = {}): ToolDescriptor<void, { writes: number; deletes: number; unchanged: number }> {
  const script = sourceReplacementScript(source, options.incremental ?? false)
  return { name: "source-replacement", version: "experiment-v1", async bind(context) {
    return async () => {
      const stdout = await runEnvironmentScript(context, script, options.signal)
      return JSON.parse(stdout.trim()) as { writes: number; deletes: number; unchanged: number }
    }
  } }
}
