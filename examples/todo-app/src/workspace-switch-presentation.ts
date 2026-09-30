/** A durable checkpoint is not a failure while an app-owned action is running.
 * Controller busy alone is not enough: startup may discover an interrupted journal. */
export function workspaceSwitchPresentation(pending: { name: string } | undefined, actionBusy: boolean) {
  if (!pending) return undefined
  return actionBusy
    ? { phase: 'switching' as const, role: 'status' as const, message: `Switching to ${pending.name}… Restoring source, preview and chat.` }
    : { phase: 'recovery' as const, role: 'alert' as const, message: `Interrupted switch to ${pending.name}. Both saved images are retained; chat is unavailable until recovery.` }
}
