// The guest process of the browser check: its own kernel instance over the
// shared memory, the kernel FsBackend, and the node:sqlite module on top.
import { attachKernel } from '../../../kernel/attach'
import { createKernel } from '../../../kernel/kernel'
import { createKernelBackend } from '../../backend-kernel'
import { createSqliteModule } from '../../node-sqlite'
// @ts-ignore plain JS shared with the Node harness
import { firstBoot, scenario } from '../scenarios.mjs'

const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]
const DATA = '/workspace/.server/data'

self.onmessage = async (e: MessageEvent) => {
  try {
    postMessage(await run(e.data))
  } catch (error) {
    postMessage({ error: String((error as Error)?.stack ?? error) })
  }
}

async function run(m: { module: WebAssembly.Module; memory: WebAssembly.Memory; sqliteModule: WebAssembly.Module; phase: string; prewarm: boolean; sync: 'request' | 'wait' | 'none' }) {
  const inst = await attachKernel({ module: m.module, memory: m.memory, canBlock: true, host: { imageRead: () => -11 } })
  const kernel = createKernel(inst)
  kernel.x.bat_host_proc_new()
  // Count and time what SQLite asks of the kernel.
  const io: Record<string, { calls: number; ms: number }> = {}
  const backend = createKernelBackend(kernel, { cwd: () => '/workspace', sync: m.sync })
  const sqlite = createSqliteModule(backend, { wasm: m.sqliteModule })
  const { DatabaseSync } = sqlite as any
  const result: Record<string, unknown> = { sync: m.sync }

  if (m.phase === 'verify') {
    // The page was reloaded while a transaction was open. The overlay came back from OPFS.
    const files = kernel.readdir(DATA).map((d) => `${d.name} ${kernel.stat(`${DATA}/${d.name}`).size}`)
    const db = new DatabaseSync(`${DATA}/keep.db`)
    result.verify = {
      filesBeforeOpen: files,
      integrity: db.prepare('pragma integrity_check').get().integrity_check,
      journalMode: db.prepare('pragma journal_mode').get().journal_mode,
      committedRows: db.prepare("select count(*) c from kept where tag = 'committed'").get().c,
      uncommittedRows: db.prepare("select count(*) c from kept where tag = 'open'").get().c,
      bigRowLength: db.prepare("select length(data) n from catalog where id = 'models'").get().n,
    }
    db.close()
    const again = new DatabaseSync(`${DATA}/keep.db`)
    ;(result.verify as any).afterCleanClose = again.prepare('select count(*) c from kept').get().c
    again.close()
    ;(result.verify as any).filesAfterClose = kernel.readdir(DATA).map((d) => `${d.name} ${kernel.stat(`${DATA}/${d.name}`).size}`)
    return result
  }

  kernel.mkdir(DATA, { recursive: true })
  kernel.mkdir('/workspace/bench', { recursive: true })
  const remove = (f: string) => {
    try {
      kernel.unlink(f)
    } catch {}
  }

  // 1. Cold: the first statements this worker (and this compiled module) ever runs.
  let prewarmMs: number | undefined
  if (m.prewarm) {
    const t = performance.now()
    sqlite.__bat.prewarm('/workspace/bench/warm.db')
    prewarmMs = performance.now() - t
  }
  const cold = firstBoot(sqlite, '/workspace/bench/cold.db', remove)
  const second = firstBoot(sqlite, '/workspace/bench/cold2.db', remove)
  result.firstBoot = { prewarmed: m.prewarm, prewarmMs, coldMs: cold, secondMs: second, engine: { ...sqlite.__bat.engine } }

  // 2. Warm scenarios, as bench.mjs: one untimed pass, then the median of 5.
  scenario(sqlite, '/workspace/bench', 'warm')
  const runs: Record<string, number>[] = []
  for (let i = 0; i < 5; i++) runs.push(scenario(sqlite, '/workspace/bench', i))
  result.scenarios = Object.fromEntries(Object.keys(runs[0]).map((k) => [k, { median: +median(runs.map((r) => r[k])).toFixed(2), min: +Math.min(...runs.map((r) => r[k])).toFixed(2) }]))
  for (const d of kernel.readdir('/workspace/bench')) remove(`/workspace/bench/${d.name}`)

  // 3. Durability: a committed transaction and a 6 MB row, flushed to OPFS; then
  //    a transaction left open with its pages already spilled to the WAL, also
  //    flushed. The page is reloaded in that state.
  const db = new DatabaseSync(`${DATA}/keep.db`)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL')
  db.exec('create table kept(id integer primary key, tag text not null, payload text); create table catalog(id text primary key, data text)')
  const insert = db.prepare('insert into kept(tag, payload) values (?, ?)')
  db.exec('begin')
  for (let i = 0; i < 500; i++) insert.run('committed', `row ${i} ${'x'.repeat(200)}`)
  db.prepare('insert into catalog values (?, ?)').run('models', 'm'.repeat(6 * 1024 * 1024))
  const tCommit = performance.now()
  db.exec('commit')
  const commitMs = performance.now() - tCommit
  const tFlush = performance.now()
  await kernel.flush()
  const flushAfterCommitMs = performance.now() - tFlush
  db.exec('PRAGMA cache_size = 10; begin')
  for (let i = 0; i < 3000; i++) insert.run('open', `row ${i} ${'y'.repeat(300)}`)
  await kernel.flush()
  result.durability = {
    commitMs,
    flushAfterCommitMs,
    filesAtReload: kernel.readdir(DATA).map((d) => `${d.name} ${kernel.stat(`${DATA}/${d.name}`).size}`),
    inTransaction: db.isTransaction,
  }
  void io
  return result
}
