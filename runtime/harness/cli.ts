#!/usr/bin/env bun
// Command-line driver for the runtime harness page.
//
//   bun runtime/harness/cli.ts run <host-file.js|.mjs|.ts> [args…]   copy the file into the guest and run it with node
//   bun runtime/harness/cli.ts run -e '<code>' [args…]               inline CommonJS (use --esm for a module)
//   bun runtime/harness/cli.ts run --guest /app/server.js [args…]    run a file that is already in the guest
//   bun runtime/harness/cli.ts node <node args…>                     raw `node …` in the guest
//   bun runtime/harness/cli.ts launch agent|preview [args…]          the manifest's launch (entry, args, cwd, env)
//   bun runtime/harness/cli.ts start run|node|launch …                 same, in the background: prints the pid
//   bun runtime/harness/cli.ts status <pid> | stop <pid>              output so far / kill and final output
//   bun runtime/harness/cli.ts reload                                reboot the page (fresh kernel and overlay)
//   bun runtime/harness/cli.ts eval '<js run in the page>'           e.g. 'batHarness.stats()'
//
// Options (before the script): --cwd DIR  --env K=V (repeatable)  --timeout MS  --trace  --json  --stdin TEXT  --keep-stdin
//   --reload (reboot first)  --build (run runtime/build.ts first)  --query 'v=3&spare=0' (page query; implies reload)
//
// The server (runtime/harness/server.ts, port 4102) is started if it is not running. The page
// lives in the browser-control session `bat-node`.
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const PORT = Number(process.env.BAT_HARNESS_PORT ?? 4102)
const SESSION = process.env.BAT_HARNESS_SESSION ?? 'bat-node'
const ORIGIN = `http://127.0.0.1:${PORT}`
const here = import.meta.dir

const argv = process.argv.slice(2)
const command = argv.shift()
const opts = { cwd: undefined as string | undefined, env: {} as Record<string, string>, timeout: 120000, trace: false, json: false, reload: false, build: false, query: undefined as string | undefined, esm: false, guest: false, stdin: undefined as string | undefined, keepStdin: false }
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
  else if (a === '--keep-stdin') opts.keepStdin = true
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
  if (command === 'status' || command === 'stop') {
    const r = evaluate(`batHarness.${command}(${Number(argv[0])})`)
    if (!r) throw new Error(`no background process ${argv[0]}`)
    if (r.stdout) process.stdout.write(r.stdout)
    if (r.stderr) process.stderr.write(r.stderr)
    console.error(`[harness] pid ${argv[0]} ${r.running ? 'running' : `exited ${r.code}`}`)
    return
  }
  // `start <run|node|launch …>`: the same, but returns the pid at once and leaves the program running.
  let background = false
  let command2 = command
  if (command === 'start') {
    background = true
    command2 = argv.shift()!
    while (argv.length && argv[0].startsWith('--')) {
      const a = argv.shift()!
      if (a === '--env') {
        const kv = argv.shift()!
        opts.env[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1)
      } else if (a === '--cwd') opts.cwd = argv.shift()
      else if (a === '--guest') opts.guest = true
    }
  }
  const run: any = { args: [], cwd: opts.cwd, env: opts.env, timeoutMs: opts.timeout, trace: opts.trace, files: {}, stdin: opts.stdin, keepStdin: opts.keepStdin }
  if (command2 === 'node') run.args = argv
  else if (command2 === 'launch') {
    // `launch agent|preview [extra args]`: entry, args, cwd and env from the manifest's launch block.
    const launch = evaluate(`batHarness.manifest.launch[${JSON.stringify(argv[0])}]`)
    if (!launch) throw new Error(`manifest has no launch.${argv[0]}`)
    run.args = [launch.entry, ...launch.args, ...argv.slice(1)]
    run.cwd = opts.cwd ?? launch.cwd
    run.env = { ...launch.env, ...opts.env }
    // What the host does before starting a program: its directories exist (HOME, XDG_*, TMPDIR).
    run.dirs = Object.entries<string>(launch.env).filter(([k, v]) => /HOME$|^TMPDIR$/.test(k) && v.startsWith('/')).map(([, v]) => v)
    if (argv[0] === 'agent') run.env = { OPENCODE_DATABASE_PATH: `${launch.env.XDG_DATA_HOME}/opencode.db`, OPENCODE_PASSWORD: 'harness', ...run.env }
  }
  else if (command2 === 'run') {
    if (inline !== undefined) {
      const name = `/workspace/.harness/inline-${Date.now().toString(36)}.${opts.esm ? 'mjs' : 'cjs'}`
      run.files[name] = inline
      run.args = [name, ...argv]
    } else if (opts.guest) run.args = argv
    else {
      const host = argv.shift()
      if (!host) throw new Error('run: which script?')
      // The script's siblings come along, so a guest can be several files.
      const dir = dirname(host)
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        const st = statSync(p)
        if (st.isFile() && st.size < 1 << 20) run.files[`/workspace/.harness/${f}`] = readFileSync(p, 'utf8')
      }
      run.args = [`/workspace/.harness/${basename(host)}`, ...argv]
    }
  } else throw new Error(`unknown command ${command}`)
  if (background) {
    run.timeoutMs = 0
    console.log(browser(`return await page.evaluate(async (o) => { await window.batHarness.ready; return window.batHarness.start(o) }, ${JSON.stringify(run)})`))
    return
  }
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
