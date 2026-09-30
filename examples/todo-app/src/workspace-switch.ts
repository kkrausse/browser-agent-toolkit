import { validateWorkspace, upsert, type Catalog, type SavedWorkspace } from './local-workspaces'

/** App orchestration only. Stop/clear/start remain owned library operations.
 * The pending validated image is durable before the first destructive action. */
export async function switchWorkspace(options: {
  incoming: unknown
  catalog: Catalog
  retry?: boolean
  assertIdle(): void
  capture(): Promise<SavedWorkspace>
  persist(catalog: Catalog): Promise<void>
  disposeChat(): Promise<void>
  stop(): Promise<void>
  replace(saved: SavedWorkspace): Promise<void>
  start(saved: SavedWorkspace): Promise<void>
}): Promise<Catalog> {
  const incoming = validateWorkspace(options.incoming)
  options.assertIdle()
  let catalog = options.catalog
  if (!options.retry) catalog = upsert(catalog, validateWorkspace(await options.capture()))
  options.assertIdle()
  catalog = { ...upsert(catalog, incoming), pending: incoming }
  await options.persist(catalog)
  await options.disposeChat()
  await options.stop()
  await options.replace(incoming)
  await options.start(incoming)
  catalog = { ...upsert(catalog, incoming), activeId: incoming.id, pending: undefined }
  await options.persist(catalog)
  return catalog
}
