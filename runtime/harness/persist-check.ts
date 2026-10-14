#!/usr/bin/env bun
// Persistence of a large overlay, in Chrome: the checks behind docs/design/decisions.md,
// "a snapshot is written through, not copied" (the tab freeze of 2026-10-13).
//
//   bun runtime/harness/persist-check.ts [case…]      every case when none is named
//   bun runtime/harness/persist-check.ts --measure     snapshot time and kernel memory for a 60 MiB overlay
//
//   fold        four 30 MiB files, then the idle fold into a snapshot: the guest runs commands
//               afterwards, and a reload restores the files (before the fix the fold's one
//               allocation was refused, the kernel trapped holding the filesystem lock and the
//               next command never returned)
//   refused     a file larger than a 64 MiB kernel memory: the write fails with ENOSPC, the
//               process and the guest live on, and what was written before is still restored
//   crash       the tab's process is killed in the middle of snapshots and of journal writes,
//               at several delays: everything flushed before is intact after each restore
//   old-format  a snapshot as written before 2026-10-13 (each file one record) is restored, and
//               a journal frame that begins before the snapshot is applied from the snapshot on
//   no-persist  a directory named by the boot option `noPersist`: what is written there is in
//               neither the journal nor a snapshot, and is gone at the next open
//   dead        a kernel call traps with the filesystem lock held: the page's calls and the
//               supervisor's fail with an error at once, `onFatal` is called, nothing spins
//
// Starts its own server (BAT_HARNESS_PORT, default 4104; `--origin <url>` uses a running
// one instead, e.g. an earlier build's) and its own Chrome (BAT_CHROME, default
// /opt/google/chrome/chrome, else Playwright's Chromium) with a profile of its own, and
// stops both. Exit code 0 when every case passed.
import { chromium, type BrowserContext, type Page } from 'playwright'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name: string) => (argv.includes(name) ? argv.splice(argv.indexOf(name), 2)[1] : undefined)
const given = flag('--origin')
const measure = argv.includes('--measure') && !!argv.splice(argv.indexOf('--measure'), 1)
const port = Number(process.env.BAT_HARNESS_PORT ?? 4104)
const origin = given ?? `http://127.0.0.1:${port}`
const MIB = 1 << 20
const run = `${Date.now().toString(36)}`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
class Hang extends Error {}
function within<T>(ms: number, what: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Hang(`no answer in ${ms / 1000} s: ${what}`)), ms)))]).finally(() => clearTimeout(timer))
}

let server: ReturnType<typeof spawn> | undefined
if (!given) {
  server = spawn('bun', [join(import.meta.dir, 'server.ts'), String(port)], { stdio: 'ignore' })
  for (let i = 0; ; i++) {
    if (await fetch(origin).then((r) => r.ok, () => false)) break
    if (i > 50) throw new Error(`harness server did not start on ${origin}`)
    await sleep(100)
  }
}
const profile = mkdtempSync(join(tmpdir(), 'bat-persist-check-'))
const chrome = process.env.BAT_CHROME ?? '/opt/google/chrome/chrome'
let context: BrowserContext
let page: Page
const consoleLines: string[] = []
async function launch() {
  context = await chromium.launchPersistentContext(profile, { headless: true, executablePath: existsSync(chrome) ? chrome : undefined })
  await watch(context.pages()[0] ?? (await context.newPage()))
}
async function watch(next: Page) {
  page = next
  const note = (text: string) => {
    if (/bat kernel|kerneld|RuntimeError|runtime has failed/.test(text)) consoleLines.push(text.split('\n')[0].slice(0, 300))
  }
  page.on('console', (m) => note(m.text()))
  page.on('worker', (w) => (w as any).on?.('console', (m: any) => note(m.text())))
  page.on('pageerror', (e) => note(`pageerror: ${e.message}`))
}
/** Stop the browser, by force when its page no longer answers. */
async function quit() {
  await within(5000, 'closing the browser', context.close()).catch(() => {})
  spawnSync('pkill', ['-9', '-f', profile])
}

/** Load the harness page on workspace `ns` and wait for the kernel: what was restored. */
async function open(ns: string, query = ''): Promise<any> {
  await page.goto(`${origin}/?persist=1&ns=${ns}${query}`)
  return within(90000, 'boot', page.evaluate(async () => {
    const h = (window as any).batHarness
    await h.ready
    return h.boot.restored
  }))
}
/** `node -e code args…` in the guest. */
function node(code: string, args: string[] = [], timeoutMs = 60000): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  const o = { args: ['/workspace/.harness/check.cjs', ...args], files: { '/workspace/.harness/check.cjs': code }, timeoutMs: 0 }
  return within(timeoutMs, `node ${args.join(' ')}`, page.evaluate((o) => (window as any).batHarness.run(o), o))
}
const inPage = <T,>(what: string, fn: string, ms = 20000): Promise<T> => within(ms, what, page.evaluate(`(async () => { const h = window.batHarness; const k = h.kernel; return await (${fn}) })()`) as Promise<T>)
const memory = () => inPage<{ inUse: number; peakInUse: number; refused: number }>('memory', 'k.memoryStats()')
const stats = () => inPage<{ snapshots: number; journalSize: number }>('kerneld stats', 'h.stats()', 10000)
const mib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`

/** Write `count` MiB of the byte `fill` to `path`, a megabyte at a time, as a download does. */
const WRITE = `const fs=require('fs');const [path,count,fill]=process.argv.slice(2);const b=Buffer.alloc(1<<20,Number(fill));const h=fs.openSync(path,'w');for(let i=0;i<Number(count);i++)fs.writeSync(h,b);fs.closeSync(h);console.log('wrote',path)`
/** Size of each file under /workspace/<dir> and whether all of it is its fill byte (the name's number + 7). */
const survey = (dir: string) =>
  inPage<Record<string, { size: number; ok: boolean }>>(`reading ${dir}`, `(() => {
    const out = {}
    for (const e of k.readdir('/workspace/${dir}')) {
      const data = k.readFile('/workspace/${dir}/' + e.name)
      const fill = Number(/\\d+/.exec(e.name)[0]) + 7
      let ok = true
      for (let i = 0; i < data.length; i += 4093) if (data[i] !== fill) ok = false
      if (data.length && data[data.length - 1] !== fill) ok = false
      out[e.name] = { size: data.length, ok }
    }
    return out
  })()`, 60000)
function expect(cond: unknown, text: string): asserts cond {
  if (!cond) throw new Error(text)
}

const cases: Record<string, () => Promise<string>> = {
  async fold() {
    const ns = `pc-${run}-fold`
    await open(ns)
    await node(`require('fs').mkdirSync('/workspace/source',{recursive:true})`)
    for (let i = 0; i < 4; i++) {
      const r = await node(WRITE, [`/workspace/source/f${i}.bin`, '30', String(i + 7)])
      expect(r.code === 0, `write ${i}: exit ${r.code} ${r.stderr}`)
    }
    const before = await memory()
    // The fold happens by itself once the overlay has been quiet for 5 s.
    for (let i = 0; (await stats()).snapshots === 0; i++) {
      expect(i < 40, 'no snapshot 20 s after the last write')
      await sleep(500)
    }
    const after = await node(`const fs=require('fs');fs.writeFileSync('/workspace/after.txt','still here');console.log(fs.readdirSync('/workspace/source').length)`, [], 20000)
    expect(after.code === 0 && after.stdout.trim() === '4', `command after the fold: exit ${after.code} ${after.stdout} ${after.stderr}`)
    await inPage('flush', 'k.flush()')
    const mem = await memory()
    const restored = await open(ns)
    const files = await survey('source')
    expect(Object.keys(files).length === 4 && Object.values(files).every((f) => f.size === 30 * MIB && f.ok), `restored files: ${JSON.stringify(files)}`)
    expect((await inPage<string>('after.txt', `new TextDecoder().decode(k.readFile('/workspace/after.txt'))`)) === 'still here', 'after.txt not restored')
    return `120 MiB folded with ${mib(before.inUse)} in use; peak ${mib(before.peakInUse)} -> ${mib(mem.peakInUse)}; restored ${mib(restored.snapshotBytes)} snapshot + ${restored.journalBytes} journal bytes in ${restored.ms.toFixed(0)} ms`
  },

  async refused() {
    const ns = `pc-${run}-refused`
    await open(ns, '&kmem=1024')
    await node(`require('fs').mkdirSync('/workspace/source',{recursive:true})`)
    expect((await node(WRITE, ['/workspace/source/f0.bin', '8', '7'])).code === 0, 'first write failed')
    const big = await node(`const fs=require('fs');const b=Buffer.alloc(1<<20,9);const h=fs.openSync('/workspace/big.bin','w');let n=0;try{for(;n<80;n++)fs.writeSync(h,b)}catch(e){console.log(e.code,n)}fs.closeSync(h);fs.unlinkSync('/workspace/big.bin');console.log('alive')`)
    expect(big.code === 0 && /^ENOSPC \d+\nalive/.test(big.stdout), `the oversized write: exit ${big.code} ${big.stdout} ${big.stderr}`)
    const later = await node(`console.log(require('fs').statSync('/workspace/source/f0.bin').size)`, [], 20000)
    expect(later.code === 0 && later.stdout.trim() === String(8 * MIB), `command after the refusal: ${later.code} ${later.stdout} ${later.stderr}`)
    const snap = await inPage<{ bytes: number }>('snapshot', `h.boot.kerneld('snapshot')`)
    await open(ns, '&kmem=1024')
    const files = await survey('source')
    expect(files['f0.bin']?.size === 8 * MIB && files['f0.bin'].ok, `restored: ${JSON.stringify(files)}`)
    return `write refused after ${big.stdout.split('\n')[0].split(' ')[1]} MiB of a 64 MiB memory, guest alive, ${mib(snap.bytes)} snapshot restored`
  },

  async crash() {
    const ns = `pc-${run}-crash`
    await open(ns)
    await node(`require('fs').mkdirSync('/workspace/source',{recursive:true})`)
    const durable: Record<string, number> = {}
    for (let i = 0; i < 3; i++) {
      expect((await node(WRITE, [`/workspace/source/f${i}.bin`, '20', String(i + 7)])).code === 0, 'write failed')
      durable[`f${i}.bin`] = 20 * MIB
    }
    await inPage('flush', 'k.flush()')
    const seen: string[] = []
    let n = 3
    for (const kind of ['snapshot', 'journal'] as const) {
      for (const delay of [0, 5, 10, 20, 35, 50, 80, 200]) {
        const name = `f${n++}.bin`
        const crash = await context.newCDPSession(page)
        if (kind === 'snapshot') {
          // A snapshot of everything, and the tab dies while it is being written.
          await inPage('start', `(k.writeFile('/workspace/source/${name}', new Uint8Array(4 << 20).fill(${n - 1 + 7})), void h.boot.kerneld('snapshot').catch(() => {}), 0)`)
        } else {
          // A process writing 16 MiB, and the tab dies while the journal takes it.
          await inPage('start', `h.start(${JSON.stringify({ args: ['/workspace/.harness/check.cjs', `/workspace/source/${name}`, '16', String(n - 1 + 7)], files: { '/workspace/.harness/check.cjs': WRITE } })})`)
        }
        await sleep(delay)
        // The renderer process is killed: the page and its workers stop wherever they are.
        void crash.send('Page.crash').catch(() => {})
        await sleep(300)
        await page.close().catch(() => {})
        await watch(await context.newPage())
        const restored = await open(ns)
        const files = await survey('source')
        for (const [file, size] of Object.entries(durable)) expect(files[file]?.size === size && files[file].ok, `${kind} +${delay} ms: ${file} is ${JSON.stringify(files[file])} after the restore`)
        for (const [file, f] of Object.entries(files)) expect(f.ok && (file in durable || file === name), `${kind} +${delay} ms: unexpected ${file} ${JSON.stringify(f)}`)
        // The slot that was not restored from: a snapshot cut short has no header.
        const torn = await inPage<string>('slots', `(async () => {
          const dir = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('bat')).getDirectoryHandle('${ns}')).getDirectoryHandle('overlay')
          let out = ''
          for (const slot of ['snap-a', 'snap-b']) {
            const file = await (await dir.getFileHandle(slot)).getFile()
            const head = new Uint8Array(await file.slice(0, 8).arrayBuffer())
            if (file.size > 0 && String.fromCharCode(...head) !== 'BATSNAP1') out += slot + ' torn at ' + file.size + ' bytes '
          }
          return out
        })()`)
        seen.push(`${kind}+${delay}ms: ${name} ${files[name] ? mib(files[name].size) : 'absent'}, snapshot seq ${restored.snapshotSeq}, ${restored.journalFrames} frames${torn ? `, ${torn.trim()}` : ''}`)
        // What survived is what the next round must find again.
        if (files[name]) {
          await inPage('flush', 'k.flush()')
          durable[name] = files[name].size
        }
      }
    }
    const r = await node(`console.log(require('fs').readdirSync('/workspace/source').length)`, [], 20000)
    expect(r.code === 0, 'command after the restores failed')
    return `16 crashes of the tab, everything flushed intact after each\n    ${seen.join('\n    ')}`
  },

  async 'old-format'() {
    const ns = `pc-${run}-old`
    // A document of this origin that boots nothing, to write the workspace's files as an
    // earlier build left them: one record per node, a file's contents inside its record.
    await page.goto(`${origin}/sw.js`)
    await within(20000, 'writing the old snapshot', page.evaluate(async ([ns, fileBytes]) => {
      const enc = new TextEncoder()
      const parts: Uint8Array[] = []
      const record = (op: number, fields: (number | ['f64', number] | Uint8Array)[]) => {
        const len = fields.reduce<number>((n, f) => n + (typeof f === 'number' ? 4 : f instanceof Uint8Array ? 4 + f.length : 8), 0)
        const out = new Uint8Array(5 + len)
        const dv = new DataView(out.buffer)
        out[0] = op
        dv.setUint32(1, len, true)
        let at = 5
        for (const f of fields) {
          if (typeof f === 'number') (dv.setUint32(at, f, true), (at += 4))
          else if (f instanceof Uint8Array) (dv.setUint32(at, f.length, true), out.set(f, at + 4), (at += 4 + f.length))
          else (dv.setFloat64(at, f[1], true), (at += 8))
        }
        parts.push(out)
      }
      const node = (ino: number, kind: number, mode: number, data: Uint8Array) => record(1, [ino, kind, mode, 0, ['f64', 1760000000000], data])
      const link = (parent: number, name: string, ino: number) => record(2, [parent, ino, enc.encode(name)])
      record(6, [0, 0o755, ['f64', 1760000000000]])
      node(1, 1, 0o755, new Uint8Array(0))
      node(2, 0, 0o644, new Uint8Array(fileBytes).fill(9))
      node(3, 0, 0o644, enc.encode('small'))
      node(4, 2, 0o777, enc.encode('f2.bin'))
      link(0, 'old', 1)
      link(1, 'f2.bin', 2)
      link(1, 'note0.txt', 3)
      link(1, 'link', 4)
      const body = new Blob(parts as BlobPart[])
      const head = new Uint8Array(32)
      head.set(enc.encode('BATSNAP1'))
      const dv = new DataView(head.buffer)
      dv.setFloat64(8, body.size, true) // sequence number: the records' bytes
      dv.setFloat64(16, body.size, true)
      dv.setUint32(24, 1, true)
      let dir = await navigator.storage.getDirectory()
      for (const part of ['bat', ns as string, 'overlay']) dir = await dir.getDirectoryHandle(part, { create: true })
      const put = async (name: string, blob: Blob) => {
        const w = await (await dir.getFileHandle(name, { create: true })).createWritable()
        await w.write(blob)
        await w.close()
      }
      await put('snap-a', new Blob([head, body]))
      // And the journal as a page that went between a snapshot's last byte and the cut of
      // the journal leaves it: a frame that begins before the snapshot's sequence number.
      // Its first records are in the snapshot already (node 3 was something else before it
      // became note0.txt); applied again they would undo note0.txt.
      parts.length = 0
      node(3, 0, 0o644, enc.encode('an earlier file'))
      link(1, 'earlier.txt', 3)
      record(3, [1, enc.encode('earlier.txt')])
      const covered = parts.reduce((n, part) => n + part.length, 0)
      node(9, 0, 0o644, enc.encode('from the journal'))
      link(1, 'journal0.txt', 9)
      const payload = new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer())
      let sum = 0x811c9dc5
      for (const b of payload) sum = Math.imul(sum ^ b, 0x01000193)
      const frame = new Uint8Array(24)
      const fv = new DataView(frame.buffer)
      fv.setUint32(0, 0x4a544142, true)
      fv.setUint32(4, payload.length, true)
      fv.setUint32(8, sum >>> 0, true)
      fv.setFloat64(16, body.size + payload.length - covered, true)
      await put('journal', new Blob([frame, payload]))
    }, [ns, 6 * MIB] as const))
    const restored = await open(ns)
    const got = await inPage<{ size: number; fill: boolean; small: string; link: string; journal: string; names: string }>('reading', `(() => {
      const data = k.readFile('/old/f2.bin')
      const text = (path) => { try { return new TextDecoder().decode(k.readFile(path)) } catch (e) { return String(e.message) } }
      return { size: data.length, fill: data.every((b) => b === 9), small: text('/old/note0.txt'), link: k.readlink('/old/link'), journal: text('/old/journal0.txt'), names: k.readdir('/old').map((e) => e.name).sort().join(' ') }
    })()`)
    expect(got.size === 6 * MIB && got.fill && got.small === 'small' && got.link === 'f2.bin', `restored ${JSON.stringify(got)}`)
    expect(got.journal === 'from the journal' && got.names === 'f2.bin journal0.txt link note0.txt', `the frame across the snapshot's sequence number: ${JSON.stringify(got)}`)
    // And it is folded into a snapshot of the present form, which restores the same.
    await inPage('snapshot', `h.boot.kerneld('snapshot')`)
    const again = await open(ns)
    const size = await inPage<number>('reading', `k.readFile('/old/f2.bin').length`)
    expect(size === 6 * MIB && again.snapshotSeq >= restored.snapshotSeq, `after the new snapshot: ${size} bytes`)
    return `a 6 MiB file in one record restored (${mib(restored.snapshotBytes)}, ${restored.ms.toFixed(0)} ms), a journal frame across the snapshot applied from the snapshot on, folded again and restored`
  },

  async 'no-persist'() {
    const ns = `pc-${run}-nopersist`
    const query = '&nopersist=/workspace/scratch'
    await open(ns, query)
    await node(`require('fs').writeFileSync('/workspace/kept.txt','kept')`)
    const wrote = await node(WRITE, ['/workspace/scratch/f0.bin', '24', '7'])
    expect(wrote.code === 0, `write under the directory: exit ${wrote.code} ${wrote.stderr}`)
    await inPage('flush', 'k.flush()')
    const journal = (await stats()).journalSize
    expect(journal < MIB, `24 MiB under a directory that is not kept made a journal of ${journal} bytes`)
    const snap = await inPage<{ bytes: number }>('snapshot', `h.boot.kerneld('snapshot')`)
    expect(snap.bytes < MIB, `and a snapshot of ${snap.bytes} bytes`)
    await open(ns, query)
    const left = await inPage<{ kept: string; scratch: string[] }>('after the reload', `({ kept: new TextDecoder().decode(k.readFile('/workspace/kept.txt')), scratch: k.readdir('/workspace/scratch').map((e) => e.name) })`)
    expect(left.kept === 'kept' && left.scratch.length === 0, `after the reload: ${JSON.stringify(left)}`)
    return `24 MiB under noPersist: ${journal} journal bytes, ${snap.bytes} snapshot bytes, gone after the reload, the rest kept`
  },

  async dead() {
    await open(`pc-${run}-dead`)
    // A real trap with the filesystem lock held: the kernel is told to replay records from
    // an address outside its memory, which it reads after taking the lock. A program is in
    // the middle of filesystem calls meanwhile.
    const got = await inPage<{ trap: string; word: number; page: string; kerneld: string; fatal: string; status: string }>('the dead kernel', `(async () => {
      const fatal = new Promise((resolve) => h.boot.onFatal((e) => resolve(String(e.message))))
      h.start({ args: ['-e', 'for(;;)require("fs").statSync("/workspace")'] })
      await new Promise((r) => setTimeout(r, 500))
      const attempt = (fn) => { try { fn(); return 'returned' } catch (e) { return String(e.message) } }
      const trap = attempt(() => k.x.bat_persist_replay(0xfffffff0, 64, 0))
      const word = Atomics.load(k.inst.i32(), k.x.BAT_KERNEL_DEAD.value >>> 2)
      const page = attempt(() => k.stat('/workspace'))
      const said = await Promise.race([fatal, new Promise((r) => setTimeout(() => r('not called'), 5000))])
      const kerneld = await h.boot.kerneld('stats').then(() => 'answered', (e) => String(e.message))
      return { trap, word, page, kerneld, fatal: said }
    })()`)
    const failed = /^The runtime has failed/
    expect(failed.test(got.trap) && got.word === 1 && failed.test(got.page) && failed.test(got.kerneld) && failed.test(got.fatal), JSON.stringify(got))
    return `a trap under the filesystem lock: "${got.trap.slice(0, 96)}…"; the page's next call and kerneld's fail with it, onFatal called`
  },
}

async function measured() {
  await open(`pc-${run}-measure`)
  await node(`require('fs').mkdirSync('/workspace/source',{recursive:true})`)
  for (let i = 0; i < 2; i++) await node(WRITE, [`/workspace/source/f${i}.bin`, '30', String(i + 7)])
  await inPage('flush', 'k.flush()')
  await sleep(1000)
  const before = await memory()
  const times: number[] = []
  let bytes = 0
  for (let i = 0; i < 5; i++) {
    const s = await inPage<{ ms: number; bytes: number }>('snapshot', `h.boot.kerneld('snapshot')`, 60000)
    times.push(s.ms)
    bytes = s.bytes
  }
  const after = await memory()
  const restored = await open(`pc-${run}-measure`)
  console.log(`overlay ${mib(bytes)}: snapshot ${times.map((t) => t.toFixed(0)).join(', ')} ms; kernel memory in use ${mib(before.inUse)}, peak before ${mib(before.peakInUse)}, peak after ${mib(after.peakInUse)} (+${mib(after.peakInUse - before.peakInUse)}); restore ${restored.ms.toFixed(0)} ms, peak after restore ${mib((await memory()).peakInUse)}`)
}

let failed = 0
try {
  if (measure) {
    await launch()
    await measured()
    await quit()
  } else {
    for (const name of argv.length ? argv : Object.keys(cases)) {
      await launch()
      consoleLines.length = 0
      try {
        console.log(`${name.padEnd(11)} ok    ${await cases[name]()}`)
      } catch (e) {
        failed++
        console.log(`${name.padEnd(11)} ${e instanceof Hang ? 'HANG ' : 'FAIL '} ${(e as Error).message}`)
        for (const line of consoleLines.slice(-6)) console.log(`    console: ${line}`)
      }
      await quit()
    }
  }
} finally {
  await quit().catch(() => {})
  server?.kill()
  rmSync(profile, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
