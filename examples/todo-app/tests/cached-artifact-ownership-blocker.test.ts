import { expect, test } from 'bun:test'
import { reusableEnvironmentExperiment } from '../../../workspace-api/src/environment-experiment'
import type { ToolContext } from '../../../workspace-api/src/types'

// Regression for the inherited Promise.all early-release bug. A failed reader
// must join its siblings and reject unproven ownership, never start fallback.
test('installed-reuse failure cannot release ownership before sibling reader settlement', async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let readerSettled = false, launches = 0
  const observations: boolean[] = []
  let stopped!: () => void
  const stopStarted = new Promise<void>(resolve => { stopped = resolve })
  const context: ToolContext = {
    readFile: async () => new TextEncoder().encode('key'),
    installFile: async () => {},
    installTree: async () => ({ files: 0, verifyMs: 0, installMs: 0, readbackMs: 0 }),
    node: async () => {
      const audit = ++launches === 1
      return {
        stdout: (async function* () { if (audit) throw Error('audit output failed'); yield new TextEncoder().encode('') })(),
        stderr: (async function* () { if (audit) { await held; readerSettled = true }; yield new Uint8Array() })(),
        exited: Promise.resolve({ exitCode: 0, signal: null, forced: false }),
        stop: async () => { stopped() }, closeStdin() {}, writeStdin() {},
      }
    },
  }
  try {
    const run = await reusableEnvironmentExperiment({
      key: 'key', entries: [], roots: ['/workspace/node_modules'], report() {},
      delivery: { name: 'fixture', version: '1', bind: async () => async () => { observations.push(readerSettled) } },
    }).bind(context)
    let completed = false
    const running = run().finally(() => { completed = true })
    const outcome = running.then(() => null, error => error)
    await stopStarted
    expect(completed).toBe(false)
    expect(observations).toEqual([])
    expect(readerSettled).toBe(false)
    release()
    const error = await outcome
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('ownership unproven')
    expect(observations).toEqual([])
  } finally {
    release()
    await held
    await Promise.resolve()
  }
  expect(readerSettled).toBe(true)
})
