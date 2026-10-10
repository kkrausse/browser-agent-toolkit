// The OpenCode server's start and configuration for this example, written against the
// runtime contract (the toolkit's runtime-host.ts) instead of the toolkit's `openEditor`.
// `openEditor` always points the server at the page server's model proxy
// (`<host>/editor/model/opencode/`), installs the plugin that wraps request headers for
// that proxy, and waits for the plugins and the proxied catalog before it calls the agent
// ready. None of that exists here: there is one provider, and its base URL is an absolute
// URL of another origin that the tab fetches directly.
import type { Launch, LaunchDescription, RuntimeEndpoint, RuntimeFs } from '@kkrausse/browser-agent-toolkit/browser'

export const workspace = '/workspace'
const state = `${workspace}/.server`
const configPath = `${state}/config/opencode/opencode.json`

export interface ModelEndpoint {
  /** Absolute base URL of an OpenAI Responses API (`<baseURL>/responses`), on any origin that allows this page by CORS. */
  baseURL: string
  /** The model id sent in requests. */
  id: string
  /** Sent as `Authorization: Bearer <apiKey>`. A mock ignores it. */
  apiKey: string
}

/** The whole global configuration: one provider, one model, file tools allowed without asking. */
export function serverConfig(model: ModelEndpoint) {
  return {
    $schema: 'https://opencode.ai/config.json',
    model: `direct/${model.id}`,
    snapshots: false,
    permissions: ['read', 'edit', 'grep', 'glob'].map(action => ({ action, resource: '*', effect: 'allow' as const })),
    providers: { direct: {
      name: new URL(model.baseURL).host,
      activation: 'enabled' as const,
      settings: { baseURL: model.baseURL, apiKey: model.apiKey },
      models: { [model.id]: {
        name: model.id, package: '@opencode/ai/providers/openai', websocket: false, disabled: false,
        capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 200000, output: 8192 },
      } },
    } },
  }
}

export async function installServerConfig(fs: RuntimeFs, model: ModelEndpoint): Promise<void> {
  for (const name of ['home', 'config/opencode/plugins', 'state', 'data', 'cache', 'tmp']) await fs.mkdir(`${state}/${name}`)
  // The server's state is inside the workspace so that it persists with it; tools that scan
  // the project by its ignore rules (Tailwind's Vite plugin) must not see it.
  await fs.writeFile(`${state}/.gitignore`, '*\n')
  // An earlier open through the toolkit's editor may have left its proxy plugins here.
  for (const name of ['editor-model-headers.js', 'editor-javascript.js', 'editor-model-catalog.js']) await fs.remove(`${state}/config/opencode/plugins/${name}`)
  await fs.writeFile(configPath, JSON.stringify(serverConfig(model), null, 2))
}

export function toLaunch(description: LaunchDescription, env: Record<string, string> = {}): Launch {
  return {
    argv: ['node', description.entry, ...(description.args ?? [])], cwd: description.cwd ?? workspace,
    env: { PATH: '/bin', HOME: `${state}/home`, ...description.env, ...env },
    programs: description.programs ?? [],
  }
}

/** `node /app/server.js`: listens on 127.0.0.1:<port> in the guest with Basic auth, ends on stdin EOF. */
export function serverLaunch(description: LaunchDescription, password: string, model: ModelEndpoint): Launch {
  const url = new URL(model.baseURL)
  const loopback = /^(localhost|127(\.\d+){3}|\[::1\])$/.test(url.hostname) && url.protocol === 'http:'
  return toLaunch(description, {
    OPENCODE_PASSWORD: password,
    OPENCODE_DATABASE_PATH: `${state}/data/opencode.sqlite`,
    // In the guest, loopback means the guest's own listeners. A model endpoint on this
    // machine's loopback (the mock) is named here so the runtime hands it to the browser.
    ...(loopback ? { BAT_HOST_LOOPBACK_PORTS: url.port || '80' } : {}),
  })
}

/** Resolves when the server answers its health check. */
export async function serverHealthy(endpoint: Pick<RuntimeEndpoint, 'fetch'>, authorization: string, signal: AbortSignal): Promise<void> {
  let last = 'no answer'
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    signal.throwIfAborted()
    try {
      const response = await endpoint.fetch('/api/health', { headers: { authorization }, signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) })
      await response.arrayBuffer()
      if (response.ok) return
      last = `HTTP ${response.status}`
    } catch (error) { last = error instanceof Error ? error.message : String(error) }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw Error(`The OpenCode server did not become healthy within 60 s (${last})`)
}
