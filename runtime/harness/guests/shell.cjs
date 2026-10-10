// The shell behind child_process (crates/bat-sh, runtime/src/process/sh.ts).
// Part 1: the calls a program makes (exec, execSync, spawn with a shell, package-script
// lines, exit codes and stderr). Part 2: every case of crates/bat-sh/tests/cases.txt, run in
// this process's shell and compared with what the machine's bash printed
// (shell-cases.json, written by crates/bat-sh/tests/expected.sh).
const cp = require('child_process')
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const { promisify } = require('util')

let failed = 0
const check = (name, fn) => {
  try {
    fn()
  } catch (e) {
    failed++
    console.log(`FAIL ${name}: ${e.message}`)
  }
}
const eq = (a, b) => assert.deepStrictEqual(a, b)

async function calls() {
  const dir = '/tmp/shell-calls'
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(`${dir}/src`, { recursive: true })
  for (const f of ['a.tsx', 'b.tsx', 'c.ts']) fs.writeFileSync(`${dir}/src/${f}`, `// ${f}\n`)
  fs.writeFileSync(`${dir}/package.json`, JSON.stringify({ name: 'calls', scripts: { hello: 'NODE_ENV=production node -e "console.log(process.env.NODE_ENV, process.argv.length)"', fail: 'echo before && exit 3' } }, null, 2))
  fs.mkdirSync(`${dir}/node_modules/.bin`, { recursive: true })
  fs.writeFileSync(`${dir}/node_modules/.bin/tool`, '#!/usr/bin/env node\nconsole.log("tool", process.argv.slice(2).join(","))\n', { mode: 0o755 })
  process.chdir(dir)
  const exec = promisify(cp.exec)

  check('execSync pipe', () => eq(cp.execSync('ls src | wc -l').toString(), '3\n'))
  const r2 = await exec('cat package.json | grep name && echo ok > /tmp/x; cat /tmp/x')
  check('exec && ; redirect', () => eq(r2, { stdout: '  "name": "calls",\nok\n', stderr: '' }))
  const r3 = await new Promise((resolve) => {
    const c = cp.spawn('sh', ['-c', 'for f in src/*.tsx; do echo $f; done'])
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    c.on('close', (code, signal) => resolve({ code, signal, out }))
  })
  check('spawn sh -c for', () => eq(r3, { code: 0, signal: null, out: 'src/a.tsx\nsrc/b.tsx\n' }))
  check('env prefix + node', () => eq(cp.execSync('NODE_ENV=production node -e "console.log(process.env.NODE_ENV)"').toString(), 'production\n'))
  check('failing execSync', () => {
    let err
    try {
      cp.execSync('cat /nope/missing.txt', { stdio: 'pipe' })
    } catch (e) {
      err = e
    }
    eq([err.status, String(err.stderr)], [1, 'cat: /nope/missing.txt: No such file or directory\n'])
    assert(err.message.startsWith('Command failed: cat /nope/missing.txt'))
  })
  const r5 = await exec('echo out; echo err >&2; exit 7').catch((e) => e)
  check('failing exec', () => eq([r5.code, r5.stdout, r5.stderr, r5.killed], [7, 'out\n', 'err\n', false]))
  const r5b = await exec('nosuchprogram --flag').catch((e) => e)
  check('unknown command', () => eq([r5b.code, r5b.stderr], [127, 'sh: nosuchprogram: command not found\n']))

  check('spawnSync of a coreutil', () => eq(cp.spawnSync('ls', ['src'], { encoding: 'utf8' }).stdout, 'a.tsx\nb.tsx\nc.ts\n'))
  check('execFileSync bash -c', () => eq(cp.execFileSync('/bin/bash', ['-c', 'echo $0 $1', 'zero', 'one'], { encoding: 'utf8' }), 'zero one\n'))
  check('spawnSync shell:true', () => eq(cp.spawnSync('echo $HOME | wc -c', { shell: true, encoding: 'utf8' }).status, 0))
  check('input', () => eq(cp.execSync('tr a-z A-Z | rev', { input: 'abc\n' }).toString(), 'CBA\n'))
  check('input to a node child', () => eq(cp.execSync(`node -e "process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase()))" | cat`, { input: 'xyz\n' }).toString(), 'XYZ\n'))
  check('node child in a pipeline, stderr kept apart', () => {
    const r = cp.spawnSync('sh', ['-c', `node -e "console.log('a\\nb\\nc'); console.error('warn')" | grep -n b`], { encoding: 'utf8' })
    eq([r.status, r.stdout, r.stderr], [0, '2:b\n', 'warn\n'])
  })
  check('env and cwd options', () => eq(cp.execSync('echo $FOO; pwd', { env: { ...process.env, FOO: 'bar' }, cwd: '/tmp' }).toString(), 'bar\n/tmp\n'))
  check('stdio inherit', () => eq(cp.spawnSync('echo', ['to the terminal'], { stdio: 'inherit' }).status, 0))
  check('npm run script', () => assert.match(cp.execSync('npm run hello', { encoding: 'utf8' }), /production 1\n$/))
  check('npm run failing script', () => eq(cp.spawnSync('npm', ['run', 'fail'], { encoding: 'utf8' }).status, 3))
  check('npx local bin', () => eq(cp.execSync('npx tool x y', { encoding: 'utf8' }), 'tool x,y\n'))
  check('shell script file with shebang', () => {
    fs.writeFileSync('run.sh', '#!/usr/bin/env bash\nset -e\necho "script $1"\nls src | head -1\n', { mode: 0o755 })
    eq(cp.execFileSync('./run.sh', ['arg'], { encoding: 'utf8' }), 'script arg\na.tsx\n')
  })
  check('timeout kills the child', () => {
    const t0 = Date.now()
    const r = cp.spawnSync('sh', ['-c', 'node -e "setTimeout(() => {}, 20000)"; echo after'], { timeout: 400, encoding: 'utf8' })
    eq([r.error && r.error.code, r.status], ['ETIMEDOUT', null])
    assert(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`)
  })
  const killed = await new Promise((resolve) => {
    const c = cp.spawn('sh', ['-c', 'sleep 30; echo never'])
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    c.on('close', (code, signal) => resolve({ code, signal, out }))
    setTimeout(() => c.kill(), 150)
  })
  const group = await new Promise((resolve) => {
    // As OpenCode's shell tool does it: detached, then a signal to the group.
    const c = cp.spawn('/bin/bash', ['-c', 'node -e "setInterval(() => {}, 1000)"; echo never'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    c.on('close', (code, signal) => resolve({ code, signal, out, ms: Date.now() - t0 }))
    const t0 = Date.now()
    setTimeout(() => process.kill(-c.pid, 'SIGTERM'), 300)
  })
  check('kill of a process group', () => {
    eq([group.code === 143 || group.signal === 'SIGTERM', group.out], [true, ''])
    assert(group.ms < 3000, `took ${group.ms} ms`)
  })
  check('kill of a shell process', () => eq(killed, { code: null, signal: 'SIGTERM', out: '' }))
  const streamed = await new Promise((resolve) => {
    const c = cp.spawn('sh', ['-c', 'while read line; do echo "got $line"; done'])
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    c.on('close', (code) => resolve({ code, out }))
    c.stdin.write('one\n')
    c.stdin.end('two\n')
  })
  check('stdin of a shell process', () => eq(streamed, { code: 0, out: 'got one\ngot two\n' }))
  check('paths exist', () => eq([fs.existsSync('/bin/sh'), fs.existsSync('/bin/bash'), cp.execSync('which sh ls node').toString()], [true, true, '/bin/sh\n/bin/ls\n/usr/local/bin/node\n']))
}

function compare() {
  const { fixture, cases } = JSON.parse(fs.readFileSync(path.join(__dirname, 'shell-cases.json'), 'utf8'))
  const work = '/tmp/bat-sh-expected/work'
  // What differs for a reason that is not the shell: the host umask (file modes in `ls -l`).
  const skip = [/ls -l package\.json \| cut -c1-10/]
  let same = 0
  let skipped = 0
  for (const c of cases) {
    if (skip.some((re) => re.test(c.script))) {
      skipped++
      continue
    }
    fs.rmSync(work, { recursive: true, force: true })
    fs.mkdirSync(`${work}/empty`, { recursive: true })
    for (const [p, text] of Object.entries(fixture)) {
      fs.mkdirSync(path.dirname(`${work}/${p}`), { recursive: true })
      fs.writeFileSync(`${work}/${p}`, text)
    }
    const r = cp.spawnSync('bash', ['-c', c.script], { cwd: work, env: { PATH: process.env.PATH, HOME: '/home/user', TZ: 'UTC' }, encoding: 'utf8' })
    if (r.stdout === c.stdout && r.status === c.status && r.stderr.length > 0 === c.stderr) same++
    else {
      failed++
      console.log(`DIFF ${JSON.stringify(c.script)}\n  bash: ${JSON.stringify([c.status, c.stdout, c.stderr])}\n  here: ${JSON.stringify([r.status, r.stdout, r.stderr])}`)
    }
  }
  console.log(`compared with bash: ${same} of ${cases.length - skipped} equal (${skipped} skipped)`)
}

calls().then(() => {
  compare()
  console.log(failed ? `${failed} failed` : 'shell ok')
  process.exit(failed ? 1 : 0)
})
