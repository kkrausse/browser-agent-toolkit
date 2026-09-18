import type { Distribution, Endpoint } from '@kev-browser-agent-kit/workspace'
import { installSource } from '@kev-browser-agent-kit/workspace/delivery'
import { createDiagnosticScope } from '@kev-browser-agent-kit/workspace/diagnostics'
import type { Connection, WorkspaceController } from '@kev-browser-agent-kit/workspace/react'
import { installOpenCodeConfig, loadPrepared, preparedApps, startOpenCode } from '@kev-browser-agent-kit/opencode-chat/browser'

const base = '/editor/'

function connection(endpoint: Endpoint): Connection {
  return {
    url: endpoint.url,
    fetch(input, init) {
      const url = input instanceof Request ? input.url : new URL(String(input), endpoint.url).href
      return endpoint.fetch(url, init)
    },
  }
}

/** The application owns startup order, preview choice, readiness, and logging. */
export async function startBrowserEditor(controller: WorkspaceController): Promise<void> {
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
    ['Open local workspace', async () => void (await controller.open(distribution))],
    [
      'Install application source and OpenCode config',
      async () => {
        const workspace = controller.workspace!
        // Preserve is explicit: browser edits win over newly prepared source.
        await installSource(workspace, manifest.project, { existing: 'preserve' })
        const modelBaseURL = `http://host.vivari.internal:${location.port || (location.protocol === 'https:' ? '443' : '80')}${base}model/opencode/`
        await installOpenCodeConfig(workspace, { modelBaseURL, additionalToolActions: ['shell'] })
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
        const preview = async () => {
          await controller.launch('vite', manifest.preview, 5173, async (endpoint) => {
            const response = await endpoint.fetch('/', {
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
            })
            if (!response.ok) throw new Error(`Preview HTTP ${response.status}`)
            return connection(endpoint)
          })
          await controller.waitForClient('vite')
        }
        const results = await Promise.allSettled([
          preview(),
          startOpenCode(controller, { prepared: manifest, diagnostics }),
        ])
        const failed = results.find((result) => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      },
    ],
  ])
  controller.status('Ready. Ask the agent to change the app; changes stay local to this browser.')
}
