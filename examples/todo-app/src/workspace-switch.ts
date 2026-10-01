import { validateWorkspace, upsert, type Catalog, type SavedWorkspace } from './local-workspaces'
import { timedStage } from './editor-timings'

/** Which way a switch replaced the workspace. `reason` says why the full path ran. */
export type SwitchPath = { path: 'retained' | 'full'; reason?: string }

/** The retained path keeps the runtime, its installed dependencies and the OpenCode
 * process: only the preview stops and only source files are replaced. */
export interface RetainedSwitch {
  /** Why this switch must take the full path, or undefined when retaining is safe.
   * Asked once, with chat admission held and before anything is disposed or removed. */
  blocker(outgoing: SavedWorkspace, incoming: SavedWorkspace): Promise<string | undefined>
  stopPreview(): Promise<void>
  replaceSource(saved: SavedWorkspace): Promise<void>
  /** Restart the preview and reconnect chat to the server that kept running. */
  resume(saved: SavedWorkspace): Promise<void>
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300)

/** App orchestration only. Stop/clear/start remain owned library operations.
 * The pending validated image is durable before the first destructive action. */
export async function switchWorkspace(options: {
  incoming: unknown
  catalog: Catalog
  retry?: boolean
  /** Acquire exclusive chat admission; throws unless chat is idle. Not called on
   * retry, where the outgoing chat is already gone. */
  hold(): { release(): void }
  capture(): Promise<SavedWorkspace>
  persist(catalog: Catalog): Promise<void>
  disposeChat(): Promise<void>
  stop(): Promise<void>
  replace(saved: SavedWorkspace): Promise<void>
  start(saved: SavedWorkspace): Promise<void>
  /** Omit to always stop, clear and restart everything. Never used on retry. */
  retained?: RetainedSwitch
  onPath?(taken: SwitchPath): void
}): Promise<Catalog> {
  const incoming = validateWorkspace(options.incoming)
  // Admission is held, not sampled: nothing can start between capture, the
  // journal write and disposal. Disposal ends the lease, so the final release is
  // a no-op after it; on any earlier failure it makes chat usable again.
  const hold = options.retry ? undefined : options.hold()
  try {
    let catalog = options.catalog, outgoing: SavedWorkspace | undefined
    // Each step is a timing stage; timedStage passes results and rejections through.
    if (!options.retry) catalog = upsert(catalog, outgoing = validateWorkspace(await timedStage('switch.capture', () => options.capture())))
    catalog = { ...upsert(catalog, incoming), pending: incoming }
    const journal = catalog
    await timedStage('switch.journal', () => options.persist(journal))
    // Decided here, before the first destructive step. A check that cannot answer
    // is a reason for the full path, never a failed switch.
    const retained = options.retained
    let full = !retained ? 'retained path not offered' : !outgoing ? 'retry of an interrupted switch'
      : await timedStage('switch.eligibility', () => retained.blocker(outgoing, incoming).catch(error => 'eligibility check failed: ' + errorText(error)))
    await timedStage('switch.dispose-chat', () => options.disposeChat())
    if (retained && full === undefined) {
      options.onPath?.({ path: 'retained' })
      try {
        await timedStage('switch.stop-preview', () => retained.stopPreview())
        await timedStage('switch.replace-source', () => retained.replaceSource(incoming))
        await timedStage('switch.resume', () => retained.resume(incoming))
      } catch (error) {
        // Possibly half replaced. The journal already names the incoming image, so
        // recover exactly as Retry interrupted switch would: the full path below.
        full = 'retained path failed: ' + errorText(error)
        await timedStage('switch.dispose-chat', () => options.disposeChat())
      }
    }
    if (full !== undefined) {
      options.onPath?.({ path: 'full', reason: full })
      await timedStage('switch.stop', () => options.stop())
      await timedStage('switch.replace', () => options.replace(incoming))
      await timedStage('switch.start', () => options.start(incoming))
    }
    catalog = { ...upsert(catalog, incoming), activeId: incoming.id, pending: undefined }
    const committed = catalog
    await timedStage('switch.commit', () => options.persist(committed))
    return catalog
  } finally {
    hold?.release()
  }
}

const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'resolutions', 'patchedDependencies', 'trustedDependencies', 'workspaces']
// Lockfiles, and the lock inputs preparation derived for the guest install.
const dependencyFiles = ['/bun.lock', '/bun.lockb', '/package-lock.json', '/npm-shrinkwrap.json', '/yarn.lock', '/pnpm-lock.yaml', '/.browser-editor/runtime-package.json', '/.browser-editor/runtime-bun.lock']
const sortedKeys = (_key: string, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value

/** Why the installed /workspace/node_modules, valid for `outgoing`, cannot be assumed
 * valid for `incoming`; undefined when their dependency inputs match. Key order is not
 * a difference. Whatever cannot be compared is one. */
export function dependencyMismatch(outgoing: Record<string, Uint8Array>, incoming: Record<string, Uint8Array>): string | undefined {
  const manifest = (source: Record<string, Uint8Array>): Record<string, unknown> | undefined => {
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source['/package.json']))
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
    } catch { return undefined }
  }
  const before = manifest(outgoing), after = manifest(incoming)
  if (!before || !after) return 'package.json cannot be compared'
  for (const section of dependencySections) if (JSON.stringify(before[section], sortedKeys) !== JSON.stringify(after[section], sortedKeys)) return `package.json ${section} differ`
  for (const path of dependencyFiles) {
    const a = outgoing[path], b = incoming[path]
    if (!a && !b) continue
    if (!a || !b) return `${path} is in only one workspace`
    if (a.byteLength !== b.byteLength || a.some((byte, index) => byte !== b[index])) return `${path} differs`
  }
  return undefined
}
