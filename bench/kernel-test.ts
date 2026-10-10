// Functional check of the kernel in the browser: boot, mount an image from
// OPFS, filesystem over it from the page, processes, pipes, sockets, kill,
// watch, and overlay persistence across a reload (?phase=2).
import { bootKernel } from '../runtime/src/kernel/boot'
import { K_DIR, K_SYMLINK, POLLHUP, POLLIN, TOKEN_CHILD, TOKEN_WATCH } from '../runtime/src/kernel/kernel'

const out = document.getElementById('out')!
const enc = new TextEncoder()
const dec = new TextDecoder()
const phase = Number(new URLSearchParams(location.search).get('phase') ?? 1)
const IMAGE = 'todo-node-modules.batimg'
const NM = '/workspace/node_modules'

async function main() {
  const checks: Record<string, unknown> = {}
  const fail: string[] = []
  const ok = (name: string, cond: boolean, detail?: unknown) => {
    checks[name] = detail === undefined ? cond : { ok: cond, detail }
    if (!cond) fail.push(name)
  }
  const boot = await bootKernel({
    wasmUrl: '/kernel.wasm',
    kerneldUrl: '/runtime/src/kernel/kerneld.ts',
    processWorkerUrl: '/runtime/src/kernel/process-worker.ts',
    runnerUrl: '/bench/demo-runner.ts',
    namespace: 'ktest',
    persist: true,
    noPersist: ['/workspace/.cache'],
  })
  const k = boot.kernel
  checks.boot = { ...boot.timings, restored: boot.restored }
  const stored = await boot.storeImage(IMAGE, `/bench/dist/${IMAGE}`)
  const mounted = await boot.mountImage(IMAGE, NM)
  checks.image = { stored, mounted }

  if (phase === 2) {
    ok('restored file', k.tryReadFile('/workspace/persist.txt') !== undefined && k.readText('/workspace/persist.txt') === 'kept across reload')
    ok('restored whiteout', k.tryStat(`${NM}/react/package.json`) === undefined)
    ok('restored patched image file', k.readText(`${NM}/react/index.js`) === '// patched')
    ok('cache not restored', k.tryStat('/workspace/.cache/tmp.bin') === undefined)
    ok('journal replayed or snapshot', (boot.restored?.seq ?? 0) > 0, boot.restored)
    return { phase, ok: fail.length === 0, fail, checks }
  }

  // --- filesystem from the page ---
  const react = k.stat(`${NM}/react`, true)
  ok('symlink in image', react.kind === K_SYMLINK, k.readlink(`${NM}/react`))
  const real = k.realpath(`${NM}/react/package.json`)
  ok('realpath through image symlink', real.includes('/.bun/react@'), real)
  ok('stat dir', k.stat(`${NM}/react`).kind === K_DIR)
  ok('miss', k.tryStat(`${NM}/react/nope.js`) === undefined && k.kindOf(`${NM}/nope`) === -1)
  // The page has no file handle: bodies arrive through kerneld.
  const pkg = JSON.parse(dec.decode(await k.retrying(() => k.readFile(`${NM}/react/package.json`))))
  ok('read image file from page', pkg.name === 'react', pkg.version)
  const names = k.readdir(NM)
  ok('readdir', names.length > 5 && names.some((e) => e.name === '.bun' && e.kind === K_DIR), names.length)

  k.mkdir('/workspace/src', { recursive: true })
  k.writeFile('/workspace/src/main.ts', 'export const a = 1\n')
  ok('overlay write/read', k.readText('/workspace/src/main.ts') === 'export const a = 1\n')
  const w = k.watchAdd('/workspace', true)
  const seen: string[] = []
  const exits = new Map<number, number>()
  const readable = new Map<number, () => void>()
  const stop = k.runEvents((token, mask) => {
    if (token === TOKEN_WATCH) for (const e of k.watchRead()) seen.push(`${e.kind}:${e.path}`)
    else if (token >= TOKEN_CHILD) exits.set(token - TOKEN_CHILD, mask)
    else readable.get(token)?.()
  })
  const until = async (cond: () => boolean, ms = 5000) => {
    const t = performance.now()
    while (!cond()) {
      if (performance.now() - t > ms) return false
      await new Promise((r) => setTimeout(r, 2))
    }
    return true
  }
  /** Collect everything a pipe produces until EOF. */
  const collect = (fd: number) => {
    let text = ''
    let done = false
    const buf = new Uint8Array(65536)
    const pump = () => {
      for (;;) {
        const n = k.readRaw(fd, buf)
        if (n > 0) text += dec.decode(buf.subarray(0, n))
        else {
          if (n === 0) done = true
          break
        }
      }
    }
    readable.set(fd, pump)
    k.subscribe(fd, POLLIN | POLLHUP)
    return { text: () => text, done: () => done }
  }

  k.writeFile('/workspace/src/main.ts', 'export const a = 2\n')
  k.rename('/workspace/src/main.ts', '/workspace/src/app.ts')
  await until(() => seen.length >= 3)
  ok('watch events', seen.includes('2:src/main.ts') && seen.includes('1:src/app.ts'), seen)
  k.watchRemove(w)

  // --- processes ---
  const t0 = performance.now()
  const p1 = k.spawn({ exec: '/bin/demo', argv: ['demo', 'echo', 'x'], env: { GREETING: 'hi' }, cwd: '/workspace', stdio: ['pipe', 'pipe', 'inherit'] })
  const o1 = collect(p1.stdio[1])
  k.write(p1.stdio[0], enc.encode('hello child'))
  k.close(p1.stdio[0])
  await until(() => exits.has(p1.pid) && o1.done())
  ok('spawn + stdio pipes + exit status', exits.get(p1.pid) === 3 && o1.text().includes('HELLO CHILD') && o1.text().includes('cwd=/workspace') && o1.text().includes('env=hi'), {
    out: o1.text(),
    status: exits.get(p1.pid),
    ms: +(performance.now() - t0).toFixed(1),
  })
  ok('waitpid reaps', k.waitpid(p1.pid, true) === 3)

  const t1 = performance.now()
  const p2 = k.spawn({ exec: '/bin/demo', argv: ['demo', 'server', '5173'], stdio: ['null', 'pipe', 'inherit'] })
  const o2 = collect(p2.stdio[1])
  await until(() => o2.text().includes('listening'))
  const listeningMs = performance.now() - t1
  const s = k.connect(5173)
  const sock = collect(s)
  k.write(s, enc.encode('GET / HTTP/1.1'))
  await until(() => sock.done())
  ok('socket page -> guest listener', sock.text().endsWith('you said: GET / HTTP/1.1'), { text: sock.text(), listeningMs: +listeningMs.toFixed(1) })
  k.close(s)
  await until(() => exits.has(p2.pid))

  const p3 = k.spawn({ exec: '/bin/demo', argv: ['demo', 'hang'], stdio: ['null', 'pipe', 'inherit'] })
  const o3 = collect(p3.stdio[1])
  await until(() => o3.text().includes('hanging'))
  k.kill(p3.pid, 9)
  await until(() => exits.has(p3.pid))
  ok('SIGKILL of a process blocked in the kernel', exits.get(p3.pid) === 137 && o3.done(), exits.get(p3.pid))

  const p4 = k.spawn({ exec: '/bin/demo', argv: ['demo', 'child-writes'], stdio: ['null', 'pipe', 'inherit'] })
  const o4 = collect(p4.stdio[1])
  await until(() => exits.has(p4.pid))
  ok('child sees mounts and writes the shared overlay', k.tryReadFile('/workspace/from-child.txt') !== undefined && o4.text().includes('kind=1'), o4.text())
  ok('connect refused', (() => { try { k.connect(5999); return false } catch (e: any) { return e.code === 'ECONNREFUSED' } })())

  // --- writes over the image, then persistence ---
  k.writeFile(`${NM}/react/index.js`, '// patched')
  k.unlink(`${NM}/react/package.json`)
  ok('whiteout', k.tryStat(`${NM}/react/package.json`) === undefined)
  k.writeFile('/workspace/persist.txt', 'kept across reload')
  k.mkdir('/workspace/.cache', { recursive: true })
  k.writeFile('/workspace/.cache/tmp.bin', new Uint8Array(100000))
  const tf = performance.now()
  await k.flush()
  checks.flushMs = +(performance.now() - tf).toFixed(2)
  checks.kerneld = await boot.kerneld('stats')
  checks.procs = k.procList()
  stop()
  return { phase, ok: fail.length === 0, fail, checks }
}

main()
  .then((r) => {
    ;(globalThis as any).testResult = r
    out.textContent = JSON.stringify(r, null, 2)
  })
  .catch((e) => {
    ;(globalThis as any).testResult = { ok: false, error: String(e?.stack ?? e) }
    out.textContent = String(e?.stack ?? e)
  })
