/** Close and open failure decisions, kept out of the component so they can be tested. */

export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

function hasCode(error: unknown, code: string, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 5) return false
  const value = error as { code?: unknown; cause?: unknown; errors?: unknown }
  return value.code === code || hasCode(value.cause, code, depth + 1) ||
    (Array.isArray(value.errors) && value.errors.some(item => hasCode(item, code, depth + 1)))
}

/** The controller snapshot's error code. Read through this accessor because the
 * field is newer than some workspace package builds this app compiles against. */
export function snapshotErrorCode(snapshot: object): string | undefined {
  const code = (snapshot as { errorCode?: unknown }).errorCode
  return typeof code === 'string' ? code : undefined
}

export const openedElsewhereMessage = 'This workspace is already open in another tab or window. Close the editor there, then choose Retry editing.'
/** An open rejected because this origin's workspace store is owned elsewhere.
 * Detected by code on the open step's own rejection, through cause chains and
 * aggregates. The snapshot's errorCode is not used here: STORAGE_BUSY there can
 * also come from a later step (for example a clear in progress). The message
 * match is a stopgap for kernel lock timeouts without the code; delete it once
 * every one carries STORAGE_BUSY. */
export function openedElsewhere(error: unknown): boolean {
  return hasCode(error, 'STORAGE_BUSY') || /still owned by another Vivari kernel/.test(errorText(error))
}

/** Close the editor's workspace. A normal close that cannot prove cleanup rejects
 * and leaves the workspace attached, so it can be retried. A forced close closes
 * anyway and still rejects, by design, because cleanup was never proven: that is
 * judged by the outcome (nothing attached) and returned as a warning, not a failure. */
export async function closeEditor(options: {
  force?: boolean
  close(options: { force?: boolean }): Promise<void>
  attached(): boolean
}): Promise<{ warning?: string }> {
  try { await options.close({ force: options.force }) }
  catch (error) {
    if (!options.force || options.attached()) throw error
    return { warning: `Editor closed without confirmed cleanup: preview or OpenCode may not have stopped cleanly. Files saved in this browser are kept and the editor can be reopened. (${errorText(error)})` }
  }
  return {}
}

/** The workspace is still attached after cleanup could not be proven: offer both
 * ways out. The controller's CLEANUP_FAILED code is the primary signal. `failure`
 * is this app's own record of an exit, or the stop inside a switch, that rejected;
 * it outlives the controller's error (cleared by the next action) and also covers
 * an exit that failed before closing, such as a save that could not complete. */
export function exitRecovery(state: { errorCode?: string; failure?: string; attached: boolean }) {
  if (!state.attached || (state.errorCode !== 'CLEANUP_FAILED' && !state.failure)) return undefined
  return {
    role: 'alert' as const,
    message: 'The editor is still open: exit or stop did not complete. Files saved in this browser are kept.' + (state.failure ? ` (${state.failure})` : ''),
    actions: ['retry', 'force'] as const,
  }
}
