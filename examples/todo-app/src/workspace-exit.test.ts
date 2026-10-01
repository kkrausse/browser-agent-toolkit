import { expect, test } from 'bun:test'
import { closeEditor, exitRecovery, openedElsewhere, snapshotErrorCode } from './workspace-exit'

const coded = (code: string, message: string) => Object.assign(new Error(message), { code })
// Mirrors WorkspaceController.close: unproven cleanup rejects and stays attached;
// force detaches and still rejects.
function controller() {
  let attached = true
  const calls: boolean[] = []
  return {
    calls, attached: () => attached,
    async close(options: { force?: boolean }) {
      calls.push(!!options.force)
      if (!options.force) throw coded('CLEANUP_FAILED', 'Service cleanup timed out with 1 service stop(s) outstanding; quiescence unproven')
      attached = false
      throw new AggregateError([coded('CLEANUP_FAILED', 'unproven')], 'Workspace force-closed; cleanup unproven (unproven)')
    },
  }
}

test('a close that cannot prove cleanup offers retry and force, and force exit ends closed with a warning', async () => {
  const c = controller()
  let failure: string | undefined
  await closeEditor(c).catch(error => { failure = error.message })
  expect(failure).toContain('quiescence unproven')
  expect(c.attached()).toBe(true)
  expect(exitRecovery({ failure, attached: c.attached() })?.actions).toEqual(['retry', 'force'])
  // The controller's code alone is enough, and unrelated errors offer nothing.
  expect(exitRecovery({ errorCode: snapshotErrorCode({ errorCode: 'CLEANUP_FAILED' }), attached: true })?.actions).toEqual(['retry', 'force'])
  expect(exitRecovery({ errorCode: snapshotErrorCode({ errorCode: 'STORAGE_BUSY' }), attached: true })).toBeUndefined()
  expect(exitRecovery({ errorCode: snapshotErrorCode({}), attached: true })).toBeUndefined()
  await expect(closeEditor(c)).rejects.toThrow('quiescence unproven')
  const result = await closeEditor({ ...c, force: true })
  expect(c.calls).toEqual([false, false, true])
  expect(c.attached()).toBe(false)
  expect(result.warning).toContain('without confirmed cleanup')
  expect(exitRecovery({ failure, errorCode: 'CLEANUP_FAILED', attached: c.attached() })).toBeUndefined()
})

test('a forced close that leaves the workspace attached is still a failure', async () => {
  await expect(closeEditor({ force: true, attached: () => true, close: async () => { throw Error('host destroy failed') } })).rejects.toThrow('host destroy failed')
})

test('a STORAGE_BUSY open is classified as open elsewhere, by code and through added context', () => {
  const busy = coded('STORAGE_BUSY', 'lock wait expired')
  expect(openedElsewhere(busy)).toBe(true)
  expect(openedElsewhere(new Error('Workspace.open (STORAGE_BUSY): lock wait expired; last stage x', { cause: busy }))).toBe(true)
  expect(openedElsewhere(new AggregateError([busy], 'open failed'))).toBe(true)
  expect(openedElsewhere(Error('Workspace.open: kernel worker boot failed: Error: OPFS still owned by another Vivari kernel after 10000ms'))).toBe(true)
  expect(openedElsewhere(coded('BACKEND_UNAVAILABLE', 'no OPFS'))).toBe(false)
  expect(openedElsewhere(Error('Runtime unavailable: HTTP 503'))).toBe(false)
})
