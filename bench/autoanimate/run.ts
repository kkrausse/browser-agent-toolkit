#!/usr/bin/env bun
// Run autoanimate's check, lint and find in the guest of the runtime harness
// page, time them and watch the tab's memory
// (docs/experiments/2026-10-12-autoanimate-commands-in-guest.md).
//
//   bun bench/autoanimate/run.ts <staged dir> [--scenes a,b] [--runs 3] [--out DIR] [--query 'spare=0'] [--probe] [--image FILE.batimg]
//
// <staged dir> is what stage.ts wrote. It is served from this process (port
// BAT_AA_FILES_PORT, default 4173, with CORS: the harness page is
// cross-origin isolated). For each command the harness page is reloaded (a
// fresh kernel and overlay, nothing of an earlier run in it), every staged
// file is fetched by the page and written into the guest under /autoanimate,
// and the command is run `--runs` times as
// `node scene-api/guest/dist/<name>.mjs …` with cwd /autoanimate: the first
// run is the cold one, the rest are warm. Prints one JSON object. With --out,
// the stdout and stderr of each command's last run are written there
// (<command>-<scene>.out / .err), to compare with a native run. --probe also
// runs scene-api/guest/dist/probe.mjs twice per scene (time by stage). With
// --image the files are not written one by one: that image (the staged
// directory packed by `bat-prepare pack <staged dir> --root /autoanimate -o FILE`)
// is stored and mounted at /autoanimate, as a layer of a prepared app would be.
//
// Memory is the renderer process of the tab as the OS sees it
// (/proc/<pid>/smaps_rollup, sampled every 50 ms while a command runs): the
// process is found by making the page spin for a second and taking the Chrome
// renderer that used the CPU. Linux only.
//
// The harness itself is runtime/harness/cli.ts: BAT_HARNESS_PORT,
// BAT_HARNESS_SESSION and BAT_PREPARED mean what they mean there.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, normalize } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name: string, fallback: string) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv.splice(at, 2)[1]! : fallback
}
const has = (name: string) => {
  const at = argv.indexOf(name)
  if (at >= 0) argv.splice(at, 1)
  return at >= 0
}
const scenes = flag('--scenes', 'gromen-excerpt').split(',')
const runs = Number(flag('--runs', '3'))
const outDir = flag('--out', '')
const query = flag('--query', '')
const probe = has('--probe')
const image = flag('--image', '')
const staged = argv[0]
if (!staged) {
  console.error('usage: bun bench/autoanimate/run.ts <staged dir> [--scenes a,b] [--runs N] [--out DIR] [--query Q] [--probe]')
  process.exit(2)
}
const FILES_PORT = Number(process.env.BAT_AA_FILES_PORT ?? 4173)
const ROOT = '/autoanimate'
const cli = join(import.meta.dir, '../../runtime/harness/cli.ts')

const server = Bun.serve({
  port: FILES_PORT,
  hostname: '127.0.0.1',
  fetch(req) {
    const path = normalize(decodeURIComponent(new URL(req.url).pathname))
    if (path.includes('..')) return new Response('forbidden', { status: 403 })
    return new Response(Bun.file(path === '/__image' ? image : join(staged, path)), {
      headers: { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-store' },
    })
  },
})

/** Not spawnSync: this process also serves the files the page fetches. */
async function harness(args: string[]): Promise<{ stdout: string; stderr: string; status: number }> {
  const child = Bun.spawn(['bun', cli, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, status }
}
async function evaluate<T>(expression: string): Promise<T> {
  const r = await harness(['eval', expression])
  if (r.status !== 0) throw new Error(`harness eval: ${r.stderr || r.stdout}`)
  return JSON.parse(r.stdout) as T
}

interface Loaded {
  files: number
  bytes: number
  fetchMs: number
  writeMs: number
}
/** A fresh kernel with the staged files in its overlay. */
async function boot(): Promise<{ booted: unknown; loaded: Loaded }> {
  const booted = await harness(['reload', ...(query ? [query] : [])])
  if (booted.status !== 0) throw new Error(`harness reload: ${booted.stderr || booted.stdout}`)
  if (image) {
    const mounted = await evaluate<Loaded>(`(async () => {
      const t0 = performance.now()
      const name = 'autoanimate-' + Date.now().toString(36) + '.batimg'
      const stored = await batHarness.boot.storeImage(name, 'http://127.0.0.1:${FILES_PORT}/__image')
      const t1 = performance.now()
      const m = await batHarness.boot.mountImage(name, '${ROOT}')
      await batHarness.spare()
      return { files: m.entries, bytes: stored.bytes, fetchMs: +(t1 - t0).toFixed(0), writeMs: +(performance.now() - t1).toFixed(0) }
    })()`)
    return { booted: JSON.parse(booted.stdout), loaded: mounted }
  }
  const loaded = await evaluate<Loaded>(`(async () => {
    const base = 'http://127.0.0.1:${FILES_PORT}/'
    const k = batHarness.kernel
    const list = await (await fetch(base + 'files.json')).json()
    const t0 = performance.now()
    const bodies = await Promise.all(list.map(async (f) => new Uint8Array(await (await fetch(base + f.path)).arrayBuffer())))
    const t1 = performance.now()
    let bytes = 0
    list.forEach((f, i) => {
      const path = '${ROOT}/' + f.path
      k.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
      k.writeFile(path, bodies[i])
      bytes += bodies[i].length
    })
    await batHarness.spare()
    return { files: list.length, bytes, fetchMs: +(t1 - t0).toFixed(0), writeMs: +(performance.now() - t1).toFixed(0) }
  })()`)
  return { booted: JSON.parse(booted.stdout), loaded }
}

// --- the tab's renderer process, as the OS sees it ---

const renderers = (): number[] =>
  readdirSync('/proc').filter((name) => /^\d+$/.test(name)).map(Number).filter((pid) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type=renderer')
    } catch {
      return false
    }
  })
/** CPU ticks (user + system) a process has used. */
const ticks = (pid: number): number => {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')
    return Number(fields[11]) + Number(fields[12])
  } catch {
    return 0
  }
}
/** The renderer of the harness page: the one that works while the page spins. */
async function rendererOfPage(): Promise<number> {
  const pids = renderers()
  const before = new Map(pids.map((pid) => [pid, ticks(pid)]))
  await evaluate(`(() => { const until = performance.now() + 1500; let n = 0; while (performance.now() < until) n++; return n })()`)
  const used = pids.map((pid) => ({ pid, used: ticks(pid) - before.get(pid)! })).sort((a, b) => b.used - a.used)
  if (!used[0] || used[0].used < 80) throw new Error(`no renderer spun with the page: ${JSON.stringify(used.slice(0, 3))}`)
  return used[0].pid
}
interface Rollup {
  rssMb: number
  pssMb: number
  /** Private memory that is not a file: the JavaScript heaps, mostly. */
  anonymousMb: number
  /** Shared memory: the kernel's wasm memory and what else the tab shares. */
  shmemMb: number
}
function rollup(pid: number): Rollup | undefined {
  try {
    const text = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8')
    const mb = (name: string) => +(Number(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(text)?.[1] ?? 0) / 1024).toFixed(0)
    return { rssMb: mb('Rss'), pssMb: mb('Pss'), anonymousMb: mb('Pss_Anon'), shmemMb: mb('Pss_Shmem') }
  } catch {
    return undefined
  }
}

interface Run {
  code: number | null
  ms: number
  stdout: string
  stderr: string
  timedOut: boolean
}
/** One command in the guest, and the most the renderer held while it ran. */
async function run(pid: number, args: string[]): Promise<Run & { peak: Rollup | undefined }> {
  let peak = rollup(pid)
  const sampling = setInterval(() => {
    const now = rollup(pid)
    if (now && (!peak || now.rssMb > peak.rssMb)) peak = now
  }, 50)
  // Through `eval`, not `cli.ts run`: browser-control hands back null for a value over
  // some tens of KB (a 47 KB stdout did), so the output is fetched in pieces.
  const summary = await evaluate<Omit<Run, 'stdout' | 'stderr'> & { out: number; err: number }>(`(async () => {
    const r = await batHarness.run(${JSON.stringify({ args, cwd: ROOT, timeoutMs: 180000 })})
    window.__aaRun = r
    return { code: r.code, ms: r.ms, timedOut: r.timedOut, out: r.stdout.length, err: r.stderr.length }
  })()`)
  clearInterval(sampling)
  const PIECE = 16384
  const text = async (stream: 'stdout' | 'stderr', length: number) => {
    let all = ''
    for (let at = 0; at < length; at += PIECE) all += await evaluate<string>(`window.__aaRun.${stream}.slice(${at}, ${at + PIECE})`)
    return all
  }
  return { code: summary.code, ms: summary.ms, timedOut: summary.timedOut, stdout: await text('stdout', summary.out), stderr: await text('stderr', summary.err), peak }
}

const commands: { name: string; args: string[] }[] = [
  { name: 'find', args: ['scene-api/guest/dist/find.mjs', 'eiffel', 'tower'] },
  ...scenes.flatMap((scene) => [
    { name: `check-${scene}`, args: ['scene-api/guest/dist/check.mjs', scene] },
    { name: `lint-${scene}`, args: ['scene-api/guest/dist/lint.mjs', scene] },
  ]),
]
const results: Record<string, unknown> = {}
let first: unknown
if (outDir) mkdirSync(outDir, { recursive: true })
for (const { name, args } of commands) {
  const fresh = await boot()
  first ??= fresh
  const pid = await rendererOfPage()
  const idle = rollup(pid)
  const each: Awaited<ReturnType<typeof run>>[] = []
  for (let i = 0; i < runs; i++) each.push(await run(pid, args))
  const last = each.at(-1)!
  if (outDir) {
    writeFileSync(join(outDir, `${name}.out`), last.stdout)
    writeFileSync(join(outDir, `${name}.err`), last.stderr)
  }
  results[name] = {
    codes: each.map((r) => r.code),
    coldMs: Math.round(each[0]!.ms),
    warmMs: each.slice(1).map((r) => Math.round(r.ms)),
    timedOut: each.some((r) => r.timedOut),
    // The times the command prints about itself.
    says: (last.stderr + last.stdout).split('\n').filter((line) => /^compiled | error\(s\), |type error\(s\) in|no type errors/.test(line)).map((line) => line.slice(0, 160)),
    memory: { idle, peak: each.reduce((most, r) => (r.peak && (!most || r.peak.rssMb > most.rssMb) ? r.peak : most), undefined as Rollup | undefined) },
  }
  console.error(`${name}: ${JSON.stringify(results[name])}`)
}
const probes: unknown[] = []
if (probe) {
  for (const scene of scenes) {
    await boot()
    const pid = await rendererOfPage()
    for (let i = 0; i < 2; i++) {
      const r = await run(pid, ['scene-api/guest/dist/probe.mjs', scene])
      probes.push(r.code === 0 ? { run: i === 0 ? 'cold' : 'warm', ...JSON.parse(r.stdout), wallMs: Math.round(r.ms), peak: r.peak } : { scene, code: r.code, stderr: r.stderr.slice(0, 2000) })
    }
  }
}
console.log(JSON.stringify({ scenes, query, first, results, probes }, null, 1))
server.stop(true)
