import type { ToolDescriptor } from '@kev-browser-agent-kit/workspace'
import type { ManagedEntry } from '@kev-browser-agent-kit/workspace/delivery'

// Benchmark-only, read-only stopped-tree validation. No receipt/marker shortcut.
export const retainedCaches = ['/workspace/node_modules/.vite-temp', '/workspace/node_modules/.vite', '/workspace/.browser-editor-cache/vite']
export function installedTreeAuditScript(entries: ManagedEntry[]): string {
  if (entries.some(entry => retainedCaches.some(path => entry.destination === path || entry.destination.startsWith(path + '/')))) throw Error('Cache overlaps immutable manifest')
  return `
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
}
export interface TreeAudit { valid: boolean; checked: number; reason?: string; cacheDigest?: string; inventory?: unknown[]; rootNames?: string[]; workspaceNames?: string[] }
export function installedTreeAuditTool(entries: ManagedEntry[]): ToolDescriptor<void, TreeAudit> {
  const script = installedTreeAuditScript(entries)
  return {name:'phase9-stopped-tree-audit', version:'1', async bind(context) {
    return async () => {
      const bytes = new TextEncoder().encode(script)
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2,'0')).join('')
      const path = `/workspace/.browser-editor-cache/experiments/${digest}.cjs`
      await context.installFile(path, bytes)
      const execution = await context.node({entry:path,cwd:'/workspace',signal:AbortSignal.timeout(120000)})
      execution.closeStdin()
      const drain = async (stream: AsyncIterable<Uint8Array>) => {let text=''; const decoder=new TextDecoder(); for await(const chunk of stream) text+=decoder.decode(chunk,{stream:true}); return text+decoder.decode()}
      try {
        const [stdout,stderr,exit] = await Promise.all([drain(execution.stdout),drain(execution.stderr),execution.exited])
        if(exit.exitCode !== 0) throw Error(`Audit process failed: ${stderr.slice(0,1000)}`)
        return JSON.parse(stdout.trim()) as TreeAudit
      } finally {await execution.stop()}
    }
  }}
}
