#!/usr/bin/env bun
// Command-line driver for the runtime harness page.
//
//   bun runtime/harness/cli.ts run <host-file.js|.mjs|.ts> [args…]   copy the file into the guest and run it with node
//   bun runtime/harness/cli.ts run -e '<code>' [args…]               inline CommonJS (use --esm for a module)
//   bun runtime/harness/cli.ts run --guest /app/server.js [args…]    run a file that is already in the guest
//   bun runtime/harness/cli.ts node <node args…>                     raw `node …` in the guest
//   bun runtime/harness/cli.ts reload                                reboot the page (fresh kernel and overlay)
//   bun runtime/harness/cli.ts eval '<js run in the page>'           e.g. 'batHarness.stats()'
//
// Options (before the script): --cwd DIR  --env K=V (repeatable)  --timeout MS  --trace  --json
//   --reload (reboot first)  --build (run runtime/build.ts first)  --query 'v=3&spare=0' (page query; implies reload)
//
// The server (runtime/harness/server.ts, port 4102) is started if it is not running. The page
// lives in the browser-control session `bat-node`.
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const PORT = Number(process.env.BAT_HARNESS_PORT ?? 4102)
const SESSION = process.env.BAT_HARNESS_SESSION ?? 'bat-node'
const ORIGIN = `http://127.0.0.1:${PORT}`
const here = import.meta.dir

const argv = process.argv.slice(2)
const command = argv.shift()
const opts = { cwd: undefined as string | undefined, env: {} as Record<string, string>, timeout: 120000, trace: false, json: false, reload: false, build: false, query: undefined as string | undefined, esm: false, guest: false, stdin: undefined as string | undefined }
let inline: string | undefined
while (argv.length && argv[0].startsWith('-')) {
  const a = argv.shift()!
  if (a === '--cwd') opts.cwd = argv.shift()
  else if (a === '--env') {
    const kv = argv.shift()!
    opts.env[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1)
  } else if (a === '--timeout') opts.timeout = Number(argv.shift())
  else if (a === '--trace') opts.trace = true
  else if (a === '--json') opts.json = true
  else if (a === '--reload') opts.reload = true
  else if (a === '--build') opts.build = true
  else if (a === '--query') {
    opts.query = argv.shift()
    opts.reload = true
  } else if (a === '--esm') opts.esm = true
  else if (a === '--guest') opts.guest = true
  else if (a === '--stdin') opts.stdin = argv.shift()
  else if (a === '-e') inline = argv.shift()
  else {
    argv.unshift(a)
    break
  }
}

async function serverUp(): Promise<boolean> {
  try {
    const r = await fetch(`${ORIGIN}/`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    return false
  }
}
async function ensureServer() {
  if (await serverUp()) return
  const child = spawn('bun', [join(here, 'server.ts'), String(PORT)], { detached: true, stdio: 'ignore' })
  child.unref()
  for (let i = 0; i < 50; i++) {
    if (await serverUp()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`harness server did not start on ${ORIGIN}`)
}

/** Run code in the browser-control session; returns the JSON value. */
function browser(code: string, timeoutMs = 180000): any {
  const dir = mkdtempSync(join(tmpdir(), 'bat-harness-'))
  const file = join(dir, 'exec.js')
  writeFileSync(file, code)
  const r = spawnSync('browser-control', ['execute', '--json', '--session', SESSION, '--file', file], { encoding: 'utf8', maxBuffer: 256 << 20 })
  const text = r.stdout.trim()
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`browser-control: ${text || r.stderr}`)
  }
  if (!parsed.ok) throw new Error(`browser-control: ${JSON.stringify(parsed.error ?? parsed).slice(0, 2000)}`)
  return parsed.value
}

function ensurePage(reload: boolean, query?: string) {
  const url = `${ORIGIN}/${query ? `?${query}` : ''}`
  return browser(`
    const want = ${JSON.stringify(url)};
    const here = page.url();
    if (${reload} || !here.startsWith(${JSON.stringify(ORIGIN)}) ) await page.goto(want);
    else if (!(await page.evaluate(() => !!window.batHarness).catch(() => false))) await page.goto(want);
    return await page.evaluate(async () => { const t = await window.batHarness.ready; return t })
  `)
}

function evaluate(expr: string) {
  return browser(`return await page.evaluate(async () => { const batHarness = window.batHarness; await batHarness.ready; return await (${expr}) })`)
}

async function main() {
  if (!command || command === 'help' || command === '--help') {
    console.log(readFileSync(import.meta.path, 'utf8').split('\n').slice(1, 16).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
    return
  }
  if (opts.build) {
    const b = spawnSync('bun', [join(here, '../build.ts')], { stdio: 'inherit' })
    if (b.status !== 0) process.exit(1)
    opts.reload = true
  }
  await ensureServer()
  if (command === 'reload') {
    console.log(JSON.stringify(ensurePage(true, opts.query ?? argv[0]), null, 1))
    return
  }
  const ready = ensurePage(opts.reload, opts.query)
  if (opts.reload && !opts.json) console.error(`[harness] booted: ${JSON.stringify(ready)}`)
  if (command === 'eval') {
    console.log(JSON.stringify(evaluate(argv.join(' ')), null, 1))
    return
  }
  const run: any = { args: [], cwd: opts.cwd, env: opts.env, timeoutMs: opts.timeout, trace: opts.trace, files: {}, stdin: opts.stdin }
  if (command === 'node') run.args = argv
  else if (command === 'run') {
    if (inline !== undefined) {
      const name = `/workspace/.harness/inline-${Date.now().toString(36)}.${opts.esm ? 'mjs' : 'cjs'}`
      run.files[name] = inline
      run.args = [name, ...argv]
    } else if (opts.guest) run.args = argv
    else {
      const host = argv.shift()
      if (!host) throw new Error('run: which script?')
      const name = `/workspace/.harness/${basename(host)}`
      run.files[name] = readFileSync(host, 'utf8')
      run.args = [name, ...argv]
    }
  } else throw new Error(`unknown command ${command}`)
  const result = browser(`return await page.evaluate(async (o) => { await window.batHarness.ready; return await window.batHarness.run(o) }, ${JSON.stringify(run)})`, opts.timeout + 30000)
  if (opts.json) {
    console.log(JSON.stringify(result))
    return
  }
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.trace) console.error(`[harness] trace ${JSON.stringify(result.trace)}`)
  console.error(`[harness] exit ${result.code}${result.timedOut ? ' (timed out, killed)' : ''} in ${result.ms.toFixed(1)} ms`)
  process.exit(result.code ?? 1)
}

main().catch((e) => {
  console.error(String(e?.message ?? e))
  process.exit(2)
})
