import type { ToolDescriptor } from '@kev-browser-agent-kit/workspace'
import type { ManagedEntry } from '@kev-browser-agent-kit/workspace/delivery'

// Benchmark-only, read-only stopped-tree validation. No receipt/marker shortcut.
export const retainedCaches = ['/workspace/node_modules/.vite-temp', '/workspace/node_modules/.vite', '/workspace/.browser-editor-cache/vite']
export interface AuditOptions {
  hashMode?: 'stream' | 'direct'
  profile?: boolean
  onTiming?(name: string, milliseconds: number): void
}
export function installedTreeAuditScript(entries: ManagedEntry[], options: AuditOptions = {}): string {
  if (entries.some(entry => retainedCaches.some(path => entry.destination === path || entry.destination.startsWith(path + '/')))) throw Error('Cache overlaps immutable manifest')
  let script = `
const fs = require('node:fs'), crypto = require('node:crypto');
const entries = ${JSON.stringify(entries)}, caches = ${JSON.stringify(retainedCaches)};
const expected = new Map(entries.map(entry => [entry.destination, entry]));
let checked = 0;
const inventory = [];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function cache(path) {
  const stat = fs.lstatSync(path);
  if (stat.isSymbolicLink()) throw Error('cache symlink: ' + path);
  if (stat.isDirectory()) { inventory.push({path, kind:'directory', mode:stat.mode & 511}); for (const name of fs.readdirSync(path).sort()) cache(path + '/' + name); }
  else if (stat.isFile()) inventory.push({path, kind:'file', mode:stat.mode & 511, bytes:stat.size, sha256:hash(fs.readFileSync(path))});
  else throw Error('unexpected cache kind: ' + path);
}
function inspect(path) {
  if (caches.includes(path)) { cache(path); return; }
  const entry = expected.get(path); if (!entry) throw Error('unexpected installed path: ' + path);
  const stat = fs.lstatSync(path);
  if (entry.kind !== 'symlink' && (stat.mode & 511) !== entry.mode) throw Error('mode mismatch: ' + path);
  if (entry.kind === 'directory') { if (!stat.isDirectory()) throw Error('not directory: ' + path); for (const name of fs.readdirSync(path).sort()) inspect(path + '/' + name); }
  else if (entry.kind === 'symlink') { if (!stat.isSymbolicLink() || fs.readlinkSync(path) !== entry.target) throw Error('symlink mismatch: ' + path); }
  else if (!stat.isFile() || stat.size !== entry.bytes || hash(fs.readFileSync(path)) !== entry.sha256) throw Error('content mismatch: ' + path);
  checked++;
}
try {
  for (const root of ['/workspace/node_modules','/workspace/.browser-editor-backends','/opencode-v2','/app']) {
    if (expected.has(root)) inspect(root);
    else if (fs.existsSync(root) && (!fs.lstatSync(root).isDirectory() || fs.readdirSync(root).length)) throw Error('unexpected installed root: ' + root);
  }
  // This cache is outside managed roots; forbid symlink ancestors before reading.
  const parent = '/workspace/.browser-editor-cache';
  if (fs.existsSync(parent) && !fs.lstatSync(parent).isDirectory()) throw Error('unsafe cache parent');
  if (fs.existsSync(caches[2])) cache(caches[2]);
  if (checked !== entries.length) throw Error('missing installed entries');
  const cacheDigest=hash(JSON.stringify(inventory)), cacheInventory=inventory.slice();
  for (const state of ['/runtime-probe','/.server','/workspace/.server']) if(fs.existsSync(state)) cache(state);
  console.log(JSON.stringify({valid:true, checked, inventory:cacheInventory, stateInventory:inventory.slice(cacheInventory.length), cacheDigest, rootNames:fs.readdirSync('/').sort(), workspaceNames:fs.readdirSync('/workspace').sort()}));
} catch (error) { console.log(JSON.stringify({valid:false, checked, reason:error.message})); }
`
  if (options.hashMode === 'direct') script = script.replace("crypto.createHash('sha256').update(bytes).digest('hex')", "crypto.hash('sha256', bytes, 'hex')")
  if (options.profile) {
    // Example-only guest profiling. Counts include caches/state; timers are
    // observational and do not replace or short-circuit any validation.
    script = script.replace("const fs = require('node:fs'), crypto = require('node:crypto');", `
const began = performance.now(), metrics = {}, counts = {};
function measure(name, fn) { const start = performance.now(); counts[name]=(counts[name]||0)+1; try { return fn(); } finally { metrics[name]=(metrics[name]||0)+performance.now()-start; } }
const rawFs = require('node:fs'), crypto = require('node:crypto');
metrics.modules = performance.now()-began;
const fs = new Proxy(rawFs, {get(target,key) { const value=target[key]; return typeof value==='function' ? (...args)=>measure(String(key),()=>value.apply(target,args)) : value; }});
const indexed = performance.now();`)
      .replace('let checked = 0;', 'metrics.manifestIndex = performance.now()-indexed; let checked = 0;')
      .replace('const hash = bytes => ', "const hash = bytes => measure('hash', () => ")
      .replace(options.hashMode === 'direct' ? "crypto.hash('sha256', bytes, 'hex');" : "crypto.createHash('sha256').update(bytes).digest('hex');", options.hashMode === 'direct' ? "crypto.hash('sha256', bytes, 'hex'));" : "crypto.createHash('sha256').update(bytes).digest('hex'));")
      .replace('function cache(path) {', "function cache(path) { return measure('cacheInclusive',()=>cacheInner(path)); } function cacheInner(path) {")
      .replace('console.log(JSON.stringify(', 'emit(')
      .replace("workspaceNames:fs.readdirSync('/workspace').sort()}));", "workspaceNames:fs.readdirSync('/workspace').sort()});")
      .replace('console.log(JSON.stringify({valid:false, checked, reason:error.message}));', 'emit({valid:false, checked, reason:error.message});')
    script += `
function emit(result) { const start=performance.now(); const serialized=JSON.stringify(result); metrics.serialization=performance.now()-start; metrics.guestTotal=performance.now()-began; console.log(JSON.stringify({...JSON.parse(serialized), profile:{metrics,counts}})); }
`
  }
  return script
}
export interface TreeAudit { valid: boolean; checked: number; reason?: string; cacheDigest?: string; inventory?: unknown[]; rootNames?: string[]; workspaceNames?: string[] }
export function installedTreeAuditTool(entries: ManagedEntry[], options: AuditOptions = {}): ToolDescriptor<void, TreeAudit> {
  const script = installedTreeAuditScript(entries, options)
  return {name:'phase9-stopped-tree-audit', version:'1', async bind(context) {
    return async () => {
      let mark = performance.now()
      const lap = (name: string) => {const now = performance.now(); options.onTiming?.(name, now-mark); mark=now}
      const bytes = new TextEncoder().encode(script)
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2,'0')).join('')
      const path = `/workspace/.browser-editor-cache/experiments/${digest}.cjs`
      lap('encodeDigest')
      await context.installFile(path, bytes)
      lap('installScript')
      const execution = await context.node({entry:path,cwd:'/workspace',signal:AbortSignal.timeout(120000)})
      const drain = async (stream: AsyncIterable<Uint8Array>) => {let text=''; const decoder=new TextDecoder(); for await(const chunk of stream) text+=decoder.decode(chunk,{stream:true}); return text+decoder.decode()}
      // Retain every owned task before observing the first failure. Rejection is
      // not permission for auditFence to reset while a sibling is still reading.
      const stdoutDrain = drain(execution.stdout), stderrDrain = drain(execution.stderr), exited = execution.exited
      let stop: Promise<unknown> | undefined
      const requestStop = () => stop ??= Promise.resolve().then(() => execution.stop())
      try {
        lap('launch')
        execution.closeStdin()
        const [stdout,stderr,exit] = await Promise.all([stdoutDrain,stderrDrain,exited])
        lap('drainExit')
        if(exit.exitCode !== 0) throw Error(`Audit process failed: ${stderr.slice(0,1000)}`)
        const result = JSON.parse(stdout.trim()) as TreeAudit
        lap('parse')
        return result
      } finally {
        // Start stop promptly, but never release ownership until all tasks join.
        // An unresolved sibling deliberately keeps the audit (and fallback) pending.
        const settled = await Promise.allSettled([requestStop(), exited, stdoutDrain, stderrDrain])
        lap('stopJoin')
        const failed = settled.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      }
    }
  }}
}
