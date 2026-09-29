import type { ToolContext, ToolDescriptor } from "./types.js"
import type { ManagedEntry, SourceDelivery } from "./delivery-types.js"

// Opt-in experiments. Normal delivery and consumers remain unchanged.
export const ENVIRONMENT_RECEIPT = "/workspace/.browser-editor-cache/environment-experiment.json"

async function runEnvironmentScript(context: ToolContext, script: string): Promise<string> {
  const bytes = new TextEncoder().encode(script)
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("")
  const path = `/workspace/.browser-editor-cache/experiments/${hash}.cjs`
  // installFile deliberately rejects conflicting writes; scripts are immutable.
  await context.installFile(path, bytes)
  const execution = await context.node({ entry: path, cwd: "/workspace", signal: AbortSignal.timeout(120000) })
  execution.closeStdin()
  const drain = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
    let text = ""
    const decoder = new TextDecoder()
    for await (const chunk of stream) text += decoder.decode(chunk, {stream: true})
    return text + decoder.decode()
  }
  try {
    const [stdout, stderr, exit] = await Promise.all([drain(execution.stdout), drain(execution.stderr), execution.exited])
    if (exit.exitCode !== 0) throw new Error(`Environment experiment process failed: ${stderr.slice(0, 1000)}`)
    return stdout
  } finally { await execution.stop() }
}

export type EnvironmentExperimentResult = {
  reused: boolean
  reason: string
  verificationMs: number
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
  report(result: EnvironmentExperimentResult): void
}): ToolDescriptor<void, void> {
  return {
    name: options.delivery.name,
    version: options.delivery.version,
    async bind(context) {
      // Preserve the toolkit's manifest/receipt validation even on a reuse hit.
      const deliver = await options.delivery.bind(context)
      return async () => {
        const started = performance.now()
        let reason = "no matching installed receipt"
        try {
          const receipt = new TextDecoder().decode(await context.readFile(ENVIRONMENT_RECEIPT))
          if (receipt === options.key) {
            const stdout = await runEnvironmentScript(context, environmentVerificationScript(options.entries, options.roots, options.disposablePaths))
            const result = JSON.parse(stdout.trim()) as { valid?: boolean; reason?: string }
            if (result.valid === true) {
              options.report({ reused: true, reason: "all installed paths, symlinks and content verified", verificationMs: performance.now() - started })
              return
            }
            reason = result.reason ?? "installed verification failed"
          }
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error)
        }
        options.report({ reused: false, reason, verificationMs: performance.now() - started })
        // Invalidate before installation: partial writes must never leave a valid receipt.
        const writeReceipt = (value: string): Promise<string> => runEnvironmentScript(context, `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(ENVIRONMENT_RECEIPT)}, ${JSON.stringify(value)});`)
        await writeReceipt("")
        await deliver()
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
export function experimentalSourceReplacementTool(source: SourceDelivery, options: { incremental?: boolean } = {}): ToolDescriptor<void, { writes: number; deletes: number; unchanged: number }> {
  const script = sourceReplacementScript(source, options.incremental ?? false)
  return { name: "source-replacement", version: "experiment-v1", async bind(context) {
    return async () => {
      const stdout = await runEnvironmentScript(context, script)
      return JSON.parse(stdout.trim()) as { writes: number; deletes: number; unchanged: number }
    }
  } }
}
