import { validateWorkspace, upsert, type Catalog, type SavedWorkspace } from './local-workspaces'
import { timedStage } from './editor-timings'

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
}): Promise<Catalog> {
  const incoming = validateWorkspace(options.incoming)
  // Admission is held, not sampled: nothing can start between capture, the
  // journal write and disposal. Disposal ends the lease, so the final release is
  // a no-op after it; on any earlier failure it makes chat usable again.
  const hold = options.retry ? undefined : options.hold()
  try {
    let catalog = options.catalog
    // Each step is a timing stage; timedStage passes results and rejections through.
    if (!options.retry) catalog = upsert(catalog, validateWorkspace(await timedStage('switch.capture', () => options.capture())))
    catalog = { ...upsert(catalog, incoming), pending: incoming }
    const journal = catalog
    await timedStage('switch.journal', () => options.persist(journal))
    await timedStage('switch.dispose-chat', () => options.disposeChat())
    await timedStage('switch.stop', () => options.stop())
    await timedStage('switch.replace', () => options.replace(incoming))
    await timedStage('switch.start', () => options.start(incoming))
    catalog = { ...upsert(catalog, incoming), activeId: incoming.id, pending: undefined }
    const committed = catalog
    await timedStage('switch.commit', () => options.persist(committed))
    return catalog
  } finally {
    hold?.release()
  }
}
