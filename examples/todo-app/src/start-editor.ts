import type { Distribution, Endpoint, NodeLaunchOptions } from '@kev-browser-agent-kit/workspace'
import { installSource } from '@kev-browser-agent-kit/workspace/delivery'
import { createDiagnosticScope } from '@kev-browser-agent-kit/workspace/diagnostics'
import type { Connection, Service, WorkspaceController } from '@kev-browser-agent-kit/workspace/react'
import { openedElsewhere, openedElsewhereMessage, errorText } from './workspace-exit'
import { installOpenCodeConfig, loadPrepared, openCodeTrace, preparedApps, startOpenCode } from '@kev-browser-agent-kit/opencode-chat/browser'

const base = '/editor/'
// Measurement only: ?opencodeTrace=1 launches OpenCode through its tracing entry, which
// prints OPENCODE_TRACE lines on guest stdout (captured by `bun run editor:debug`).
const openCodeTraced = () => new URLSearchParams(location.search).get('opencodeTrace') === '1'
declare global { interface Window { __openCodeTrace?: { dump(label?: string, detail?: boolean, probe?: { megabytes: number[]; fill?: 'x' | 'random'; shape?: 'rows' | 'one' }): Promise<unknown> } } }
export const readyStatus = 'Ready. Ask the agent to change the app; changes stay local to this browser.'

function connection(endpoint: Endpoint): Connection {
  return {
    url: endpoint.url,
    fetch(input, init) {
      const url = input instanceof Request ? input.url : new URL(String(input), endpoint.url).href
      return endpoint.fetch(url, init)
    },
  }
}

/** Launch the Vite preview and wait until the mounted frame shows the application. */
export async function startPreview(controller: WorkspaceController, preview: NodeLaunchOptions): Promise<void> {
  await controller.launch('vite', preview, 5173, async (endpoint) => {
    const response = await endpoint.fetch('/', {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
    })
    if (!response.ok) throw new Error(`Preview HTTP ${response.status}`)
    return connection(endpoint)
  })
  await controller.waitForClient('vite')
}

/** The application owns startup order, preview choice, readiness, and logging.
 * Resolves with the preview's launch, which a retained switch reuses. */
export async function startBrowserEditor(controller: WorkspaceController, options: {
  beforeSource?(controller: WorkspaceController): Promise<void>
  beforeChatConnect?(service: Service): Promise<void>
  chatConnectReady?(): void
} = {}): Promise<{ preview: NodeLaunchOptions }> {
  const diagnostics = createDiagnosticScope(
    (event) => controller.diagnostic(event.event, event.data),
    controller.diagnosticRunId,
  )
  let manifest!: Awaited<ReturnType<typeof loadPrepared>>
  let distribution!: Distribution

  await controller.steps([
    [
      'Load prepared assets',
      async () => {
        manifest = await loadPrepared(base + 'prepared/', controller.signal, diagnostics)
        const response = await fetch(base + 'runtime/distribution.json', { signal: controller.signal })
        if (!response.ok) throw new Error(`Runtime unavailable: HTTP ${response.status}`)
        const runtime = await response.json()
        if (runtime.version !== manifest.runtimeVersion) throw new Error('Prepared runtime version mismatch')
        distribution = { name: 'vivari', version: runtime.version, assetBaseUrl: base + 'runtime/' }
      },
    ],
    ['Open local workspace', async () => {
      try { await controller.open(distribution) }
      catch (error) {
        if (!openedElsewhere(error)) throw error
        // The raw lock detail stays in Activity; the alert says what to do.
        controller.log(errorText(error))
        throw new Error(openedElsewhereMessage, { cause: error })
      }
    }],
    [
      'Install application source and OpenCode config',
      async () => {
        const workspace = controller.workspace!
        await options.beforeSource?.(controller)
        // Preserve is explicit: browser edits win over newly prepared source.
        // Known logical workspaces already own their complete source tree; do
        // not resurrect files that the agent removed on a previous visit.
        let initialized = false
        try { await workspace.fs.stat('/.todo-workspace.json'); initialized = true } catch { /* legacy first open */ }
        // Timing context: whether this open restored a stored working copy.
        controller.diagnostic('editor.source', { initialized })
        if (!initialized) await installSource(workspace, manifest.project, { existing: 'preserve' })
        const modelBaseURL = `http://host.vivari.internal:${location.port || (location.protocol === 'https:' ? '443' : '80')}${base}model/opencode/`
        await installOpenCodeConfig(workspace, {
          modelBaseURL, additionalToolActions: ['shell'],
          models: manifest.modelCatalog, defaultModel: manifest.editorDefaultModel,
          ...(openCodeTraced() ? { trace: true } : {}),
        })
        await workspace.flush()
      },
    ],
    [
      'Deliver managed dependencies and tools',
      async () => {
        if (controller.runtime) return
        const runtime = await controller.startRuntime({
          apps: preparedApps(manifest, base + 'prepared/', controller.signal, controller.log, diagnostics),
        })
        try {
          await runtime.tools.apps()
        } catch (error) {
          await controller.stopRuntime()
          throw error
        }
      },
    ],
    [
      'Start preview and OpenCode',
      async () => {
        // Both services share one guest kernel. Qualify the preview before
        // starting OpenCode's module/plugin boot, as in the qualified single-
        // kernel suite: cold Vite must not compete with chat for its listen
        // budget. Keep the same per-service deadlines and failure ownership.
        await startPreview(controller, manifest.preview)
        const traced = openCodeTraced()
        const service = await startOpenCode(controller, { prepared: manifest, diagnostics, waitForClient: false, ...(traced ? { trace: true } : {}) })
        // The guest's full counters on demand; the call also prints a summary line on its stdout.
        if (traced) window.__openCodeTrace = {
          // `probe` also times statements on a scratch database grown to each size (blocks the guest meanwhile).
          dump: async (label = '', detail = false, probe) => (await service.connection.fetch(new URL(`${openCodeTrace.dumpPath.slice(1)}?${new URLSearchParams({
            label, detail: detail ? '1' : '0', probe: (probe?.megabytes ?? []).join(','), fill: probe?.fill ?? 'x', shape: probe?.shape ?? 'rows',
          })}`, service.connection.url).href)).json(),
        }
        await options.beforeChatConnect?.(service)
        options.chatConnectReady?.()
        await controller.waitForClient('chat')
      },
    ],
  ])
  controller.status(readyStatus)
  return { preview: manifest.preview }
}
