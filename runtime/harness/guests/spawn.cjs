// child_process: spawnSync of node itself, async spawn with pipes, exec, a .bin shim, ENOENT, exit codes, fork IPC.
const cp = require('child_process')
const assert = require('assert')
const path = require('path')
if (process.argv[2] === 'child') {
  process.stdout.write(`child ${process.argv.slice(3).join(',')} cwd=${process.cwd()} env=${process.env.FOO}\n`)
  process.stderr.write('child stderr\n')
  let input = ''
  process.stdin.on('data', (d) => (input += d))
  process.stdin.on('end', () => {
    process.stdout.write(`stdin=${input}`)
    process.exit(3)
  })
  return
}
if (process.argv[2] === 'ipc') {
  process.on('message', (m) => {
    process.send({ echo: m, pid: process.pid })
    if (m === 'bye') process.disconnect()
  })
  return
}
const t0 = performance.now()
const r = cp.spawnSync(process.execPath, [__filename, 'child', 'a', 'b'], { input: 'from parent', env: { ...process.env, FOO: 'bar' }, cwd: '/tmp', encoding: 'utf8' })
const syncMs = performance.now() - t0
assert.strictEqual(r.status, 3, JSON.stringify(r))
assert.strictEqual(r.stdout, 'child a,b cwd=/tmp env=bar\nstdin=from parent')
assert.strictEqual(r.stderr, 'child stderr\n')
console.log('spawnSync ok', syncMs.toFixed(1), 'ms')

const e = cp.spawnSync('definitely-not-a-command', ['x'])
assert.strictEqual(e.error && e.error.code, 'ENOENT')
assert.throws(() => cp.execFileSync('nope-nope'), (err) => err.code === 'ENOENT')
const out = cp.execFileSync(process.execPath, ['-e', 'console.log(6*7)'], { encoding: 'utf8' })
assert.strictEqual(out, '42\n')
assert.strictEqual(cp.execSync('node -p "1+1"').toString(), '2\n')
assert.throws(() => cp.execFileSync('node', ['-e', 'process.exit(5)']), (err) => err.status === 5)
// A .bin shim: Bun links node_modules/.bin/vite -> ../vite/bin/vite.js
const v = cp.spawnSync('vite', ['--version'], { encoding: 'utf8' })
console.log('vite --version:', JSON.stringify(v.stdout.trim()), v.status, v.error ? v.error.code : '', v.stderr.slice(0, 300))

const child = cp.spawn('node', [__filename, 'child', 'async'], { env: { ...process.env, FOO: 'x' } })
let got = ''
child.stdout.on('data', (d) => (got += d))
child.on('error', (err) => { console.log('spawn error', err); process.exit(1) })
child.stdin.end('piped')
child.on('close', (code, signal) => {
  assert.strictEqual(code, 3)
  assert.strictEqual(got, `child async cwd=${process.cwd()} env=x\nstdin=piped`)
  console.log('spawn ok')
  const missing = cp.spawn('no-such-binary')
  missing.on('error', (err) => {
    assert.strictEqual(err.code, 'ENOENT')
    console.log('spawn ENOENT ok')
    cp.exec(`node ${path.basename(__filename)} child viaexec`, { cwd: __dirname }, (err, stdout, stderr) => {
      assert.strictEqual(err && err.code, 3)
      assert.ok(stdout.startsWith('child viaexec'), stdout)
      console.log('exec ok')
      const f = cp.fork(__filename, ['ipc'])
      const seen = []
      f.on('message', (m) => {
        seen.push(m.echo)
        if (m.echo === 'hi') f.send('bye')
      })
      f.on('exit', (code) => {
        assert.deepStrictEqual(seen, ['hi', 'bye'])
        console.log('fork ipc ok', code)
        const k = cp.spawn('node', ['-e', 'setInterval(()=>{},1000)'])
        k.on('spawn', () => setTimeout(() => k.kill('SIGKILL'), 20))
        k.on('exit', (code, signal) => console.log('kill ok', code, signal))
      })
      f.send('hi')
    })
  })
})
