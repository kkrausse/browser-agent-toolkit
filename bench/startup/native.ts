#!/usr/bin/env bun
// The native baseline for the same two programs, from the same prepared tree: Node 24 on
// this machine, guest paths reproduced with a mount namespace (bubblewrap) so that
// `/workspace` and `/app` are what the guest sees (Vite's shipped optimizer cache is only
// valid at the path it was prepared for).
//
//   bun bench/startup/native.ts [--n 7] [--prepared <dir>] [--label native] [--node <binary>]
//
//   vite      spawn → "ready" line → document → every module of the first page fetched
//             (what the preview frame requests, transitively), cache as shipped by prepare
//   opencode  spawn → listening line → /api/health 200 → plugin activation → the toolkit's
//             whole readiness sequence (plugins, config, model), same configuration files
//             the toolkit writes
// Each run is in its own network namespace, so the programs listen on their real ports
// (5173, 4096) without touching the machine's. The timing code is native-inner.ts.
// Runs are interleaved (vite, opencode, vite, …), each a new process with a new workspace
// copy (Vite writes its config temp file below node_modules, so that mount is writable),
// and the load average is recorded with each. Output: bench/startup/out/<label>.json
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { decodeSourceFile } from '../../packages/toolkit/src/manifest'
import { agentLaunch, installAgentConfig } from '../../packages/toolkit/src/opencode'

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? fallback : (process.argv[i + 1] ?? 'true')
}
const root = resolve(import.meta.dir, '../..')
const n = Number(arg('n', '7'))
const editorPort = arg('editor-port', '4120')
// --compile-cache: give Node its on-disk V8 code cache (NODE_COMPILE_CACHE), the counterpart of the browser's.
const compileCache = process.argv.includes('--compile-cache')
const label = arg('label', 'native')!
const prepared = resolve(arg('prepared', join(root, 'target-perf/tree/examples/todo-app/.editor/prepared'))!)
const work = `${prepared}.work`
const scratch = join(root, 'target-perf/native')
const node = arg('node', process.env.NODE ?? 'node')!
const manifest = JSON.parse(readFileSync(join(prepared, 'manifest.json'), 'utf8'))
const derived: Record<string, any> = manifest.derived ? JSON.parse(readFileSync(join(prepared, manifest.derived.file), 'utf8')) : {}
const openCodeDir = resolve(process.env.BAT_OPENCODE_DIR ?? join(root, '.runtime/opencode-2.0.3'))
const load = () => readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).map(Number)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A workspace exactly as a first open leaves it: project source, derived cache, dependencies. */
function makeWorkspace(dir: string) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const [path, file] of [...Object.entries(manifest.project), ...Object.entries(derived)]) {
    const target = join(dir, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, decodeSourceFile(file as any))
  }
}
function makeApp(dir: string) {
  if (existsSync(dir)) return
  mkdirSync(dir, { recursive: true })
  for (const name of ['server.js', 'tree-sitter.wasm', 'tree-sitter-bash.wasm', 'tree-sitter-powershell.wasm']) cpSync(join(openCodeDir, name), join(dir, name))
}

/** Run the inner script in a mount + network namespace: guest paths, and the guests' own ports (5173, 4096) private to the run. */
function sandboxed(ws: string, app: string, args: string[]): Promise<any> {
  const binds = ['/usr', '/bin', '/lib', '/lib64', '/sbin', '/etc', '/home', '/tmp', '/var', '/opt', '/run'].filter(existsSync).flatMap((d) => ['--bind', d, d])
  mkdirSync(join(ws, 'node_modules'), { recursive: true })
  mkdirSync(join(app, 'node_modules'), { recursive: true })
  const child = spawn(
    'bwrap',
    ['--die-with-parent', '--unshare-net', ...binds, '--dev', '/dev', '--proc', '/proc', '--bind', ws, '/workspace', '--bind', join(work, 'guest/node_modules'), '/workspace/node_modules', '--bind', app, '/app', '--ro-bind', join(work, 'support/node_modules'), '/app/node_modules', '--chdir', '/', node, inner, ...args],
    { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...(compileCache ? { NODE_COMPILE_CACHE: join(scratch, `compile-cache-${args[0]}`) } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (err += d))
  return new Promise((done, fail) =>
    child.on('exit', (code) => {
      const line = out.trim().split('\n').pop() ?? ''
      try {
        if (code !== 0) throw new Error(`exit ${code}`)
        done(JSON.parse(line))
      } catch (e) {
        fail(new Error(`${(e as Error).message}\n${err.slice(-3000)}\n${out.slice(-1000)}`))
      }
    }),
  )
}

async function vite(ws: string, app: string) {
  makeWorkspace(ws)
  return sandboxed(ws, app, ['vite', JSON.stringify(manifest.launch.preview)])
}

async function openCode(ws: string, app: string) {
  makeWorkspace(ws)
  const fs = {
    mkdir: async (p: string) => void mkdirSync(join(ws, p.replace(/^\/workspace/, '')), { recursive: true }),
    writeFile: async (p: string, data: Uint8Array | string) => writeFileSync(join(ws, p.replace(/^\/workspace/, '')), data),
    remove: async (p: string) => rmSync(join(ws, p.replace(/^\/workspace/, '')), { recursive: true, force: true }),
  }
  // The model proxy URL only has to be well-formed: nothing is sent to it before a chat turn.
  await installAgentConfig(fs as any, { modelBaseURL: `http://127.0.0.1:${editorPort}/editor/model/opencode/`, models: catalog?.models, defaultModel: catalog?.defaultModel })
  const password = crypto.randomUUID() + crypto.randomUUID()
  return sandboxed(ws, app, ['opencode', JSON.stringify(agentLaunch(password, manifest.launch.agent)), password])
}

let catalog: { models: Record<string, any>; defaultModel: string } | undefined
try {
  const served = await (await fetch(`http://127.0.0.1:${editorPort}/editor/manifest.json`)).json()
  if (served.defaultModel) catalog = { models: served.modelCatalog, defaultModel: served.defaultModel }
} catch {
  console.error('no editor server on --editor-port: OpenCode runs without the host model catalog')
}

const app = join(scratch, 'app')
makeApp(app)
// The part that runs inside the namespace, as one plain Node module.
const inner = join(scratch, 'native-inner.mjs')
const built = await Bun.build({ entrypoints: [join(import.meta.dir, 'native-inner.ts')], target: 'node', format: 'esm' })
if (!built.success) throw new AggregateError(built.logs)
writeFileSync(inner, await built.outputs[0].text())
const round = (v: unknown) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)
const samples: any[] = []
for (let i = 0; i < n; i++) {
  for (const [kind, run] of [['vite', vite], ['opencode', openCode]] as const) {
    const before = load()
    try {
      const r = await run(join(scratch, `ws-${kind}`), app)
      const sample = { kind, load: before, ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, round(v)])) }
      samples.push(sample)
      console.error(`${String(i + 1).padStart(2)} ${kind.padEnd(8)} load ${before[0].toFixed(1).padStart(5)}  ${Object.entries(sample).filter(([k]) => !['kind', 'load', 'target'].includes(k)).map(([k, v]) => `${k} ${v}`).join('  ')}`)
    } catch (e) {
      console.error(`${i + 1} ${kind} failed: ${(e as Error).message.slice(0, 3000)}`)
    }
  }
}
const stat = (xs: number[]) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return undefined
  return { n: v.length, median: v.length % 2 ? v[(v.length - 1) / 2] : Math.round(((v[v.length / 2 - 1] + v[v.length / 2]) / 2) * 10) / 10, min: v[0], max: v[v.length - 1] }
}
const summary: Record<string, any> = {}
for (const kind of ['vite', 'opencode']) {
  const mine = samples.filter((s) => s.kind === kind)
  if (!mine.length) continue
  summary[kind] = { load1: stat(mine.map((s) => s.load[0])) }
  for (const key of Object.keys(mine[0])) if (typeof mine[0][key] === 'number') summary[kind][key] = stat(mine.map((s) => s[key]))
}
const nodeVersion = await new Promise<string>((done) => {
  const c = spawn(node, ['--version'])
  let out = ''
  c.stdout.on('data', (d) => (out += d))
  c.on('exit', () => done(out.trim()))
})
const out = join(import.meta.dir, 'out', `${label}.json`)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({ meta: { label, date: new Date().toISOString(), node: nodeVersion, prepared, image: manifest.image?.file }, summary, samples }, null, 1))
for (const [kind, s] of Object.entries(summary)) {
  console.log(`\n${kind} (native ${nodeVersion}), n=${s.load1.n}, load1 median ${s.load1.median}`)
  for (const [k, v] of Object.entries(s) as [string, any][]) if (k !== 'load1' && v) console.log(`  ${k.padEnd(14)} ${String(v.median).padStart(7)}  (${v.min}–${v.max})`)
}
console.log(`\n${out}`)
