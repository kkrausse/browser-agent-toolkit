// Runs inside the namespace native.ts sets up (plain Node): start one of the two programs
// exactly as its launch description says and time it. Prints one JSON line.
import { spawn } from 'node:child_process'
import { verifyAgentReady } from '../../packages/toolkit/src/opencode'

const [kind, launchJson, password] = process.argv.slice(2)
const nodeArgs = (process.env.NATIVE_NODE_ARGS ?? '').split(' ').filter(Boolean)
const finish = async (child: import('node:child_process').ChildProcess, signal: NodeJS.Signals | undefined) => {
  if (!nodeArgs.length) return void child.kill('SIGKILL')
  if (signal) child.kill(signal)
  await new Promise((r) => child.once('exit', r))
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const state = { log: '', exited: false }
async function until(test: () => boolean, what: string) {
  const deadline = Date.now() + 60000
  while (!test()) {
    if (state.exited) throw new Error(`${what}: process exited\n${state.log.slice(-3000)}`)
    if (Date.now() > deadline) throw new Error(`${what}: timed out\n${state.log.slice(-3000)}`)
    await sleep(1)
  }
}
function start(command: string[], cwd: string, env: Record<string, string>) {
  // NATIVE_NODE_ARGS (e.g. `--cpu-prof --cpu-prof-dir=/workspace/.prof`): the program then gets time to exit by itself.
  const child = spawn(process.execPath, [...nodeArgs, ...command], { cwd, env: { PATH: process.env.PATH!, ...(process.env.NODE_COMPILE_CACHE ? { NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE } : {}), ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.on('data', (d) => (state.log += d))
  child.stderr.on('data', (d) => (state.log += d))
  child.on('exit', () => (state.exited = true))
  return child
}

async function vite() {
  const launch = JSON.parse(launchJson)
  const t0 = performance.now()
  const child = start([launch.entry, ...launch.args], launch.cwd, launch.env)
  await until(() => /Local:|ready in/.test(state.log), 'vite listening')
  const listening = performance.now() - t0
  const origin = `http://127.0.0.1:${launch.port}`
  const base = `/preview/${launch.port}/`
  const seen = new Map<string, Promise<{ body: string; type: string; status: number }>>()
  const timings: { url: string; at: number; ms: number; bytes: number }[] = []
  const get = (url: string, accept: string) => {
    let p = seen.get(url)
    if (!p) {
      p = (async () => {
        const at = performance.now()
        const response = await fetch(origin + url, { headers: { accept, 'sec-fetch-dest': accept.includes('html') ? 'document' : 'script' } })
        const body = await response.text()
        timings.push({ url: url.slice(0, 90), at: Math.round(at - t0), ms: Math.round(performance.now() - at), bytes: body.length })
        return { body, type: response.headers.get('content-type') ?? '', status: response.status }
      })()
      seen.set(url, p)
    }
    return p
  }
  const importRe = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"'\n]+)["']/g
  const crawl = async (url: string): Promise<void> => {
    if (seen.has(url)) return
    const { body, type, status } = await get(url, '*/*')
    if (status !== 200 || !/javascript/.test(type)) return
    const next = new Set<string>()
    for (const match of body.matchAll(importRe)) {
      const spec = match[1]
      if (spec.startsWith('/')) next.add(spec)
      else if (spec.startsWith('.')) next.add(new URL(spec, origin + url).pathname + new URL(spec, origin + url).search)
    }
    await Promise.all([...next].map(crawl))
  }
  const html = await get(base, 'text/html')
  if (html.status !== 200) throw new Error(`document: HTTP ${html.status}\n${state.log.slice(-2000)}`)
  const document = performance.now() - t0
  const entries = new Set<string>()
  for (const match of html.body.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) entries.add(match[1])
  for (const match of html.body.matchAll(/<link[^>]*\bhref="([^"]+)"/g)) entries.add(match[1])
  for (const match of html.body.matchAll(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/g)) for (const m of match[1].matchAll(importRe)) if (m[1].startsWith('/')) entries.add(m[1])
  await Promise.all([...entries].map(crawl))
  const page = performance.now() - t0
  await sleep(300)
  const reported = /ready in (\d+)/.exec(state.log.replace(/\x1b\[[0-9;]*m/g, ''))?.[1]
  await finish(child, 'SIGTERM')
  return { listening, document, page, requests: seen.size, viteReadyIn: reported ? Number(reported) : undefined, slowest: timings.sort((a, b) => b.ms - a.ms).slice(0, 6), optimizerRan: /optimized dependencies changed|new dependencies optimized|Re-optimizing/i.test(state.log) }
}

async function openCode() {
  const launch = JSON.parse(launchJson) as { argv: string[]; cwd: string; env: Record<string, string> }
  const authorization = 'Basic ' + btoa('opencode:' + password)
  const t0 = performance.now()
  const child = start(launch.argv.slice(1), launch.cwd, { ...launch.env, PATH: `/app/node_modules/.bin:${process.env.PATH}` })
  await until(() => /OPENCODE_SERVER_PROCESS_READY/.test(state.log), 'opencode ready line')
  const listening = performance.now() - t0
  const marks: Record<string, number> = {}
  const seen = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.name.startsWith('bat:agent.')) marks[e.name.slice(10)] ??= e.startTime - t0
  })
  seen.observe({ entryTypes: ['mark'] })
  await verifyAgentReady({ fetch: (path: string, init?: RequestInit) => fetch('http://127.0.0.1:4096' + path, init) }, authorization, AbortSignal.timeout(60000))
  const ready = performance.now() - t0
  await sleep(0)
  child.stdin.end()
  await finish(child, undefined)
  return { listening, health: marks.health, activated: marks.activated, ready }
}

try {
  console.log(JSON.stringify(await (kind === 'vite' ? vite() : openCode())))
  process.exit(0)
} catch (e) {
  console.error(String((e as Error).stack ?? e), '\n', state.log.slice(-3000))
  process.exit(1)
}
