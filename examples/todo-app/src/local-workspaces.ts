import * as v from 'valibot'
import type { Workspace } from '@kev-browser-agent-kit/workspace'
import type { ChatSnapshot } from '@kev-browser-agent-kit/opencode-chat'
import { orderSessions, sessionBundleSchema } from './workspace-sessions'
import { timedStage } from './editor-timings'

export const identityPath = '/.todo-workspace.json'
// Prepared backend archives and experiment receipts/scripts belong to managed
// delivery, not logical source snapshots. Never copy them into the catalog or
// restore a receipt supplied by an incoming workspace over installed state.
const excluded = new Set(['node_modules', '.browser-editor-backends', '.browser-editor-cache', '.git', '.server', '.editor', '.react-router', 'build', '.env', '.env.local', '.env.production', '.todo-workspace.json'])
/** Top-level /workspace entries a retained switch leaves in place: OpenCode's own
 * state and configuration, and the two roots managed delivery installs there. Every
 * other entry is the outgoing workspace's, as on the full path, and is removed. */
export const retainedRoots = ['.server', 'node_modules', '.browser-editor-backends']
export function safeSourcePath(path: string): boolean {
  return path.startsWith('/') && path !== '/' && !path.split('/').slice(1).some(part => !part || part === '.' || part === '..' || /[\\\0]/.test(part) || excluded.has(part) || part.startsWith('.env.'))
}
export const savedWorkspaceSchema = v.object({
  format: v.literal(1), id: v.pipe(v.string(), v.uuid()), name: v.pipe(v.string(), v.minLength(1), v.maxLength(120)), savedAt: v.number(),
  source: v.record(v.string(), v.instance(Uint8Array)), sessions: v.array(sessionBundleSchema), selectedSessionId: v.optional(v.string()),
})
export type SavedWorkspace = v.InferOutput<typeof savedWorkspaceSchema>
export type Catalog = { activeId?: string; workspaces: SavedWorkspace[]; pending?: SavedWorkspace }
export function validateWorkspace(value: unknown): SavedWorkspace {
  const saved = v.parse(savedWorkspaceSchema, value)
  if (!Object.keys(saved.source).length || !saved.source['/package.json']) throw Error('Saved workspace has no application source')
  let bytes = 0
  for (const [path, file] of Object.entries(saved.source)) {
    if (!safeSourcePath(path)) throw Error('Unsafe saved source path: ' + path)
    bytes += file.byteLength
  }
  if (bytes > 100 * 1024 * 1024 || Object.keys(saved.source).length > 25_000) throw Error('Saved source exceeds local limits')
  orderSessions(saved.sessions)
  if (saved.selectedSessionId && !saved.sessions.some(session => session.info.id === saved.selectedSessionId)) throw Error('Saved selected session is missing')
  return saved
}

/** Advisory, for enabling controls. Admission itself is ChatController.hold(),
 * which fails on the same conditions and then keeps the chat idle. */
export function idleChat(chat: ChatSnapshot | undefined): boolean {
  return !!chat && chat.connection === 'connected' && chat.execution === 'idle' && !chat.held && !chat.sessionOperationPending && !chat.sending && !chat.loading && !chat.loadingOlder && !chat.interruptRequested && !chat.permissions.length && !chat.questions.length && !chat.unsupportedForms.length
}

/** One atomic browser-local catalog write includes outgoing snapshot and pending
 * replacement. Failed/interrupted clear therefore never loses either image. */
export function createWorkspaceStore() {
  let opening: Promise<IDBDatabase> | undefined
  const open = () => opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('todo-browser-workspaces-v1', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('catalog')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const store = {
    async read(): Promise<Catalog> {
      const db = await open()
      return new Promise((resolve, reject) => {
        const request = db.transaction('catalog').objectStore('catalog').get('current')
        request.onsuccess = () => resolve(request.result ?? { workspaces: [] })
        request.onerror = () => reject(request.error)
      })
    },
    async write(catalog: Catalog): Promise<void> {
      const db = await open()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('catalog', 'readwrite')
        transaction.objectStore('catalog').put(catalog, 'current')
        transaction.oncomplete = () => resolve()
        transaction.onerror = transaction.onabort = () => reject(transaction.error ?? Error('Local workspace save aborted'))
      })
    },
  }
  // The catalog holds every saved workspace image, so its size is timing context.
  return {
    read: () => timedStage('catalog.read', store.read, catalogSize),
    write: (catalog: Catalog) => timedStage('catalog.write', () => store.write(catalog), () => catalogSize(catalog)),
  }
}
function catalogSize(catalog: Catalog) {
  let sourceBytes = 0, sessions = 0
  for (const saved of catalog.workspaces) {
    sessions += saved.sessions.length
    for (const file of Object.values(saved.source)) sourceBytes += file.byteLength
  }
  return { workspaces: catalog.workspaces.length, sourceBytes, sessions }
}

export async function captureSource(workspace: Workspace, inspect = async (path: string) => (await import('@kev-browser-agent-kit/workspace')).diagnoseWorkspaceEntry(workspace, path)): Promise<Record<string, Uint8Array>> {
  const source: Record<string, Uint8Array> = {}
  let bytes = 0
  async function walk(directory: string): Promise<void> {
    for (const name of await workspace.fs.readdir(directory)) {
      const path = (directory === '/' ? '' : directory) + '/' + name
      // Never read secrets, and never pretend an outgoing snapshot preserved
      // them before clearing its filesystem. Leave the working copy untouched.
      if (name === '.env' || name.startsWith('.env.')) throw Error('Secret environment file cannot be included in a local workspace snapshot: ' + path)
      if (!safeSourcePath(path)) continue
      const entry = await inspect(path)
      if (entry.metadata.kind === 'symlink') throw Error('Local snapshots do not support source symlinks: ' + path)
      const stat = await workspace.fs.stat(path)
      if (stat.isDirectory) await walk(path)
      else if (stat.isFile) {
        const file = await workspace.fs.readFile(path)
        bytes += file.byteLength
        if (bytes > 100 * 1024 * 1024 || Object.keys(source).length >= 25_000) throw Error('Local source snapshot too large')
        source[path] = file
      }
    }
  }
  await timedStage('capture.source', () => walk('/'), () => ({ files: Object.keys(source).length, bytes }))
  return source
}

export async function writeIdentity(workspace: Workspace, saved: Pick<SavedWorkspace, 'id' | 'name' | 'selectedSessionId'>): Promise<void> {
  await timedStage('identity.write', async () => {
    await workspace.fs.writeFile(identityPath, JSON.stringify({ id: saved.id, name: saved.name, selectedSessionId: saved.selectedSessionId }))
    await timedStage('identity.flush', () => workspace.flush())
  })
}

export async function restoreSource(workspace: Workspace, saved: SavedWorkspace): Promise<void> {
  validateWorkspace(saved)
  await timedStage('restore.source', async () => {
    for (const [path, bytes] of Object.entries(saved.source).sort(([a], [b]) => a.localeCompare(b))) {
      await workspace.fs.mkdir(path.slice(0, path.lastIndexOf('/')) || '/')
      await workspace.fs.writeFile(path, bytes)
    }
  }, () => ({ files: Object.keys(saved.source).length }))
  await writeIdentity(workspace, saved)
}

export function upsert(catalog: Catalog, saved: SavedWorkspace): Catalog {
  return { ...catalog, workspaces: [...catalog.workspaces.filter(item => item.id !== saved.id), saved] }
}
