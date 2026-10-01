import type { Endpoint, Workspace } from '@kev-browser-agent-kit/workspace';
import type { Connection, ServiceReadiness, WorkspaceController } from '@kev-browser-agent-kit/workspace/react';
import { createDiagnosticScope, type DiagnosticScope } from '@kev-browser-agent-kit/workspace/diagnostics';
import { Effect } from 'effect';
import { modelHeaderPluginSource } from './model-headers';
import { javascriptPluginSource } from './javascript-plugin-source' with { type: 'macro' };
import { createOpenCodeCandidateConfig, createOpenCodeCandidateLaunch, modelCatalogPluginSource, openCodeCandidateLaunch, type OpenCodeCandidateModel } from './opencode-launch';
import { validatePreparedOpenCode, type PreparedManifest } from './prepared';

const javascriptPlugin = javascriptPluginSource();

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
  if (!plugins.data.some((plugin: { id: string; state?: { status: string } }) => plugin.id === 'editor.javascript' && plugin.state?.status === 'active')) return yield* Effect.fail(new Error('OpenCode guest JavaScript tool plugin is not active'));
  const entries = yield* request(descriptor.configAPIPath, async response => {
    if (!response.ok) { await response.arrayBuffer(); throw Error(`OpenCode configuration HTTP ${response.status}`); }
    return response.json();
  });
  const selected = Array.isArray(entries) && entries.find(entry => entry.type === 'document' && entry.path === descriptor.configPath);
  // The V2 config API returns the decoded model selection, even when the JSON
  // document uses the shorthand string (which older responses may preserve).
  const selection = selected?.info?.model;
  const modelID = typeof selection === 'string'
    ? (selection.startsWith('opencode/') ? selection.slice('opencode/'.length) : undefined)
    : selection?.providerID === 'opencode' ? selection.model : undefined;
  const configured = modelID && selected.info?.providers?.opencode?.models?.[modelID];
  if (!configured || typeof configured.package !== 'string' || configured.websocket !== false)
    return yield* Effect.fail(new Error('OpenCode global model configuration not loaded'));
  const { data } = yield* request(descriptor.modelPath, async response => {
    if (!response.ok) { await response.arrayBuffer(); throw Error(`OpenCode model catalog HTTP ${response.status}`); }
    return response.json();
  });
  const catalogModel = Array.isArray(data) && data.find(model => model.providerID === descriptor.model.providerID && model.id === modelID);
  if (!catalogModel?.enabled || !catalogModel.capabilities?.tools) {
    const inspect = (path: string) => request(path, async response => {
      if (!response.ok) { await response.arrayBuffer(); return { httpStatus: response.status }; }
      return response.json();
    }, 'GET', 3000).pipe(Effect.catch(() => Effect.succeed(undefined)));
    const providerResult = yield* inspect(descriptor.modelPath.replace('/api/model?', '/api/provider/opencode?'));
    const defaultResult = yield* inspect(descriptor.modelPath.replace('/api/model?', '/api/model/default?'));
    // Emit only public selection and boolean policy facts, never raw config,
    // headers, provider settings, credentials, or the complete API response.
    const provider = selected.info.providers.opencode;
    const facts = {
      providerID: descriptor.model.providerID, modelID,
      catalogArray: Array.isArray(data), catalogCount: Array.isArray(data) ? data.length : null,
      present: !!catalogModel, enabled: catalogModel ? catalogModel.enabled === true : null,
      tools: catalogModel ? catalogModel.capabilities?.tools === true : null,
      configuredTools: configured.capabilities?.tools === true,
      hostProxyMarkerLoaded: provider.settings?.apiKey === 'editor-host-proxy',
      catalogProxyMarkerLoaded: providerResult?.data?.settings?.apiKey === 'editor-host-proxy',
      catalogProviderActivation: ['enabled', 'auto', 'disabled'].includes(providerResult?.data?.activation) ? providerResult.data.activation : null,
      catalogSelectedModelIDs: Array.isArray(data) ? data.filter(model => model.providerID === descriptor.model.providerID).slice(0, 40).map(model => String(model.id).slice(0, 100)) : [],
      serverDefault: defaultResult?.data ? { providerID: String(defaultResult.data.providerID).slice(0, 100), modelID: String(defaultResult.data.id).slice(0, 100) } : null,
    };
    diagnostics.record('opencode.readiness.model-rejected', facts);
    return yield* Effect.fail(new Error('Qualified OpenCode model is not enabled with tools: ' + JSON.stringify(facts)));
  }
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
export async function installOpenCodeConfig(workspace: Workspace, options: { modelBaseURL: string; additionalToolActions?: string[]; models?: Record<string, OpenCodeCandidateModel>; defaultModel?: string }) {
  for (const directory of openCodeCandidateLaunch.workspaceDirectories) await workspace.fs.mkdir(directory);
  await workspace.fs.mkdir('/.server/config/opencode/plugins');
  await workspace.fs.writeFile('/.server/config/opencode/plugins/editor-model-headers.js', modelHeaderPluginSource(options.modelBaseURL));
  await workspace.fs.writeFile('/.server/config/opencode/plugins/editor-javascript.js', await javascriptPlugin);
  // An explicit default means the host owns the whole catalog. The workspace is
  // retained between visits, so a previous visit's catalog plugin must not survive.
  const catalogPlugin = '/.server/config/opencode/plugins/editor-model-catalog.js';
  if (options.defaultModel !== undefined) await workspace.fs.writeFile(catalogPlugin, modelCatalogPluginSource(Object.keys(options.models ?? {})));
  else if (await workspace.fs.stat(catalogPlugin).then(() => true, () => false)) await workspace.fs.remove(catalogPlugin);
  await workspace.fs.writeFile(openCodeCandidateLaunch.workspaceConfigPath, JSON.stringify(createOpenCodeCandidateConfig(options.modelBaseURL, options.additionalToolActions, options.models, options.defaultModel)));
}

/** Launch, qualify, and connect the pinned OpenCode server. It starts no preview server. */
export async function startOpenCode(controller: WorkspaceController, options: {
  prepared: Pick<PreparedManifest, 'opencode' | 'assets'>;
  serviceName?: string;
  waitForClient?: boolean;
  diagnostics?: DiagnosticScope;
  readiness?: ServiceReadiness;
}) {
  await validatePreparedOpenCode(options.prepared);
  const diagnostics = options.diagnostics ?? createDiagnosticScope(event => controller.diagnostic(event.event, event.data), controller.diagnosticRunId);
  const serviceName = options.serviceName ?? 'chat';
  const password = crypto.randomUUID() + crypto.randomUUID(), authorization = 'Basic ' + btoa('opencode:' + password);
  const service = await controller.launch(serviceName, createOpenCodeCandidateLaunch({ password, ripgrepBinDirectory: options.prepared.opencode.support.binDirectory }), openCodeCandidateLaunch.port, async (endpoint, signal) => {
    await verifyOpenCodeReady(endpoint, authorization, signal, diagnostics);
    return connection(endpoint, authorization);
  }, { shutdown: 'stdin-eof', timeoutMs: 10000 }, options.readiness);
  if (options.waitForClient ?? true) await controller.waitForClient(serviceName);
  return service;
}

export { createOpenCodeCandidateConfig, createOpenCodeCandidateLaunch, openCodeCandidateLaunch, type OpenCodeCandidateModel, type OpenCodeModelCatalog } from './opencode-launch';
export { loadPrepared, preparedApps, type PreparedManifest } from './prepared';
