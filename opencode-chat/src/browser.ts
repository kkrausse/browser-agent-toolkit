import type { Endpoint, Workspace } from '@kev-browser-agent-kit/workspace';
import type { Connection, WorkspaceController } from '@kev-browser-agent-kit/workspace/react';
import { createDiagnosticScope, type DiagnosticScope } from '@kev-browser-agent-kit/workspace/diagnostics';
import { Effect } from 'effect';
import { modelHeaderPluginSource } from './model-headers';
import { createOpenCodeCandidateConfig, createOpenCodeCandidateLaunch, openCodeCandidateLaunch } from './opencode-launch';
import { validatePreparedOpenCode, type PreparedManifest } from './prepared';

const verifyReadyEffect = Effect.fn('OpenCode.verifyReady')(function*(endpoint: Pick<Endpoint, 'fetch'>, authorization: string, diagnostics: DiagnosticScope) {
  const descriptor = openCodeCandidateLaunch;
  const request = <A>(path: string, consume: (response: Response) => Promise<A>, method = 'GET', timeout = 20000) => Effect.tryPromise({
    try: async signal => diagnostics.stage('opencode.readiness.request', async () => consume(await endpoint.fetch(path, {
      method, headers: { authorization }, signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    })), { path, method }),
    catch: (cause: unknown) => cause instanceof Error ? cause : new Error(String(cause)),
  });
  const drained = async (response: Response) => { await response.arrayBuffer(); return response; };
  const deadline = Date.now() + 30000;
  let lastFailure = new Error('OpenCode health not ready');
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return yield* Effect.fail(new Error('OpenCode health readiness timed out after 30000ms', { cause: lastFailure }));
    const health = yield* request(descriptor.healthPath, drained, 'GET', Math.min(3000, remaining)).pipe(
      Effect.catch(error => { lastFailure = error; return Effect.succeed(undefined); }),
    );
    if (health?.ok) break;
    if (health) lastFailure = new Error(`OpenCode health HTTP ${health.status}`);
    yield* Effect.sleep(Math.max(0, Math.min(100, deadline - Date.now())));
  }
  const activated = yield* request(descriptor.activation.path, drained, descriptor.activation.method);
  if (!activated.ok) return yield* Effect.fail(new Error(`OpenCode plugin activation HTTP ${activated.status}`));
  const plugins = yield* request(descriptor.pluginPath, async response => {
    if (!response.ok) { await response.arrayBuffer(); throw Error(`OpenCode plugins HTTP ${response.status}`); }
    return response.json();
  });
  if (!Array.isArray(plugins.data) || !plugins.data.some((plugin: { id: string; state?: { status: string } }) => plugin.id === 'editor.model-headers' && plugin.state?.status === 'active')) return yield* Effect.fail(new Error('OpenCode model header transport plugin is not active'));
  const entries = yield* request(descriptor.configAPIPath, async response => {
    if (!response.ok) { await response.arrayBuffer(); throw Error(`OpenCode configuration HTTP ${response.status}`); }
    return response.json();
  });
  if (!Array.isArray(entries) || !entries.some(entry => entry.type === 'document' && entry.path === descriptor.configPath
    && entry.info?.providers?.opencode?.models?.[descriptor.model.id]?.package === '@opencode/ai/providers/openai'
    && entry.info.providers.opencode.models[descriptor.model.id].websocket === false)) return yield* Effect.fail(new Error('OpenCode global model configuration not loaded'));
  const { data } = yield* request(descriptor.modelPath, async response => {
    if (!response.ok) { await response.arrayBuffer(); throw Error(`OpenCode model catalog HTTP ${response.status}`); }
    return response.json();
  });
  if (!Array.isArray(data) || !data.some(model => model.providerID === descriptor.model.providerID && model.id === descriptor.model.id
    && model.enabled && model.capabilities?.tools)) return yield* Effect.fail(new Error('Qualified OpenCode model is not enabled with tools'));
});

export function verifyOpenCodeReady(endpoint: Pick<Endpoint, 'fetch'>, authorization: string, signal: AbortSignal, diagnostics = createDiagnosticScope()) {
  return Effect.runPromise(verifyReadyEffect(endpoint, authorization, diagnostics), { signal });
}

function connection(endpoint: Endpoint, authorization: string): Connection {
  return { url: endpoint.url, async fetch(input, init) {
    const request = new Request(input instanceof Request ? input : new URL(String(input), endpoint.url), init);
    const headers = new Headers(request.headers); headers.set('authorization', authorization);
    return endpoint.fetch(request.url, { method: request.method, headers, signal: request.signal,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer() });
  } };
}

/** Write only OpenCode-owned directories, plugin, and global model configuration. */
export async function installOpenCodeConfig(workspace: Workspace, options: { modelBaseURL: string; additionalToolActions?: string[] }) {
  for (const directory of openCodeCandidateLaunch.workspaceDirectories) await workspace.fs.mkdir(directory);
  await workspace.fs.mkdir('/.server/config/opencode/plugins');
  await workspace.fs.writeFile('/.server/config/opencode/plugins/editor-model-headers.js', modelHeaderPluginSource(options.modelBaseURL));
  await workspace.fs.writeFile(openCodeCandidateLaunch.workspaceConfigPath, JSON.stringify(createOpenCodeCandidateConfig(options.modelBaseURL, options.additionalToolActions)));
}

/** Launch, qualify, and connect the pinned OpenCode server. It starts no preview server. */
export async function startOpenCode(controller: WorkspaceController, options: {
  prepared: Pick<PreparedManifest, 'opencode' | 'assets'>;
  serviceName?: string;
  waitForClient?: boolean;
  diagnostics?: DiagnosticScope;
}) {
  await validatePreparedOpenCode(options.prepared);
  const diagnostics = options.diagnostics ?? createDiagnosticScope(event => controller.diagnostic(event.event, event.data), controller.diagnosticRunId);
  const serviceName = options.serviceName ?? 'chat';
  const password = crypto.randomUUID() + crypto.randomUUID(), authorization = 'Basic ' + btoa('opencode:' + password);
  const service = await controller.launch(serviceName, createOpenCodeCandidateLaunch({ password, ripgrepBinDirectory: options.prepared.opencode.support.binDirectory }), openCodeCandidateLaunch.port, async endpoint => {
    await verifyOpenCodeReady(endpoint, authorization, controller.signal, diagnostics);
    return connection(endpoint, authorization);
  }, { shutdown: 'stdin-eof', timeoutMs: 10000 });
  if (options.waitForClient ?? true) await controller.waitForClient(serviceName);
  return service;
}

export { createOpenCodeCandidateConfig, createOpenCodeCandidateLaunch, openCodeCandidateLaunch } from './opencode-launch';
export { loadPrepared, preparedApps, type PreparedManifest } from './prepared';
