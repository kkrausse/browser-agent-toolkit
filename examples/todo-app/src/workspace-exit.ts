/** Close and open failure decisions, kept out of the component so they can be tested. */

export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

function hasCode(error: unknown, code: string, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 5) return false
  const value = error as { code?: unknown; cause?: unknown }
  return value.code === code || hasCode(value.cause, code, depth + 1)
}

export const openedElsewhereMessage = 'This workspace is already open in another tab or window. Close the editor there, then choose Retry editing.'
/** An open rejected because this origin's workspace store is owned elsewhere.
 * Detected by code. The message match is a stopgap for kernel lock timeouts
 * that do not yet carry STORAGE_BUSY; delete it once they do. */
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

/** After a failed exit, or a failed stop inside a switch, the workspace is still
 * attached: offer both ways out. */
export function exitRecovery(failure: string | undefined, attached: boolean) {
  if (!failure || !attached) return undefined
  return {
    role: 'alert' as const,
    message: `The editor is still open: exit or stop did not complete. Files saved in this browser are kept. (${failure})`,
    actions: ['retry', 'force'] as const,
  }
}
