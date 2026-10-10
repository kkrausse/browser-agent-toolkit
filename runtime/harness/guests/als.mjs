// AsyncLocalStorage across await, timers, immediates, nextTick, fs callbacks and promises, child exit; two flows interleaved.
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks'
import fs from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
const als = new AsyncLocalStorage()
const results = []
const check = (id, where) => { const got = als.getStore()?.id; results.push(got === id ? null : `${where}: expected ${id}, got ${got}`) }
async function flow(id, delay) {
  check(id, 'start')
  await sleep(delay)
  check(id, 'after timers/promises sleep')
  await new Promise((r) => setTimeout(r, delay))
  check(id, 'after setTimeout promise')
  await fs.promises.readFile('/workspace/package.json')
  check(id, 'after fs.promises')
  await new Promise((r) => fs.readFile('/workspace/package.json', r))
  check(id, 'after fs callback')
  await new Promise((r) => setImmediate(r))
  check(id, 'after setImmediate')
  await new Promise((r) => process.nextTick(r))
  check(id, 'after nextTick')
  await Promise.resolve().then(() => check(id, 'in then')).finally(() => check(id, 'in finally'))
  check(id, 'after then chain')
  await new Promise((r) => queueMicrotask(r))
  check(id, 'after queueMicrotask')
  await null
  check(id, 'after await null')
  await new Promise((resolve) => spawn(process.execPath, ['-e', '0']).on('exit', resolve))
  check(id, 'after child exit')
  const inner = await als.run({ id: id * 10 }, async () => { await sleep(1); return als.getStore().id })
  results.push(inner === id * 10 ? null : `nested: ${inner}`)
  check(id, 'after nested run')
  const ee = new EventEmitter()
  const bound = AsyncResource.bind(() => check(id, 'AsyncResource.bind'))
  setTimeout(() => ee.emit('x'), 1)
  await new Promise((r) => ee.on('x', () => { bound(); r() }))
  return id
}
const done = await Promise.all([als.run({ id: 1 }, flow, 1, 3), als.run({ id: 2 }, flow, 2, 2), als.run({ id: 3 }, flow, 3, 5)])
results.push(als.getStore() === undefined ? null : 'outside: store leaked')
// The documented gap: a continuation resumed by a promise that another context resolved.
let release
const gate = new Promise((r) => (release = r))
const waiter = als.run({ id: 7 }, async () => { await gate; return als.getStore()?.id })
als.run({ id: 8 }, () => setTimeout(release, 1))
const cross = await waiter
const failed = results.filter(Boolean)
console.log(JSON.stringify({ flows: done, checks: results.length, failed, crossContextResume: cross === 7 ? 'kept (7)' : `lost (got ${cross}; Node gives 7)` }, null, 1))
process.exitCode = failed.length ? 1 : 0
