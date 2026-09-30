import { expect, test } from 'bun:test'
import { reusableEnvironmentExperiment } from '../../../workspace-api/src/environment-experiment'
import type { ToolContext } from '../../../workspace-api/src/types'

// Characterization of the inherited helper, not acceptance of its ordering.
// Do not wire this helper into source/session switching until it joins BOTH
// readers and process exit before fallback (including failure/cancellation).
test('inherited installed-reuse fallback can precede failed-audit reader settlement', async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let readerSettled = false, launches = 0
  const observations: boolean[] = []
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
        stop: async () => {}, closeStdin() {}, writeStdin() {},
      }
    },
  }
  try {
    const run = await reusableEnvironmentExperiment({
      key: 'key', entries: [], roots: ['/workspace/node_modules'], report() {},
      delivery: { name: 'fixture', version: '1', bind: async () => async () => { observations.push(readerSettled) } },
    }).bind(context)
    await run()
    expect(observations).toEqual([false])
    expect(readerSettled).toBe(false)
  } finally {
    release()
    await held
    await Promise.resolve()
  }
  expect(readerSettled).toBe(true)
})
