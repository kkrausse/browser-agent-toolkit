import type { Endpoint, Distribution } from '@kev-browser-agent-kit/workspace';
import { Effect } from 'effect';
import type { WorkspaceController, Connection } from '@kev-browser-agent-kit/workspace/react';
import { sourcePaths } from './editor-source';
import { decodeProjectFile } from './project-file';
import { preparePreviewCache } from './preview-cache';
import { loadPrepared, preparedApps, type PreparedManifest } from './prepared';
import { createOpenCodeCandidateConfig, createOpenCodeCandidateLaunch, openCodeCandidateLaunch } from './opencode-launch';
import { createDiagnosticScope, type DiagnosticScope } from '@kev-browser-agent-kit/workspace/diagnostics';

/** Readiness is a real configured provider barrier, not just an HTTP listener. */
const verifyOpenCodeReadyEffect = Effect.fn('Workspace.verifyOpenCodeReady')(function*(endpoint: Pick<Endpoint, 'fetch'>, authorization: string, diagnostics: DiagnosticScope) {
  const descriptor = openCodeCandidateLaunch;
  // Keep body consumption inside the interruptible request so cancellation also
  // aborts a response whose headers arrived but whose body is still streaming.
  const request = <A>(path: string, consume: (response: Response) => Promise<A>, method = 'GET', timeout = 20000) => Effect.tryPromise({
    try: async signal => diagnostics.stage('opencode.readiness.request', async () => consume(await endpoint.fetch(path, {
      method, headers: { authorization }, signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    })), { path, method }),
    catch: (cause: unknown) => cause instanceof Error ? cause : new Error(String(cause)),
  });
  const drained = async (response: Response) => { await response.arrayBuffer(); return response; };
  const deadline = Date.now() + 30000;
  while (true) {
    const health = yield* request(descriptor.healthPath, drained, 'GET', 3000);
    if (health.ok) break;
    if (Date.now() >= deadline) return yield* Effect.fail(new Error(`OpenCode health HTTP ${health.status}`));
    yield* Effect.sleep(100);
  }
  const activated = yield* request(descriptor.activation.path, drained, descriptor.activation.method);
  if (!activated.ok) return yield* Effect.fail(new Error(`OpenCode plugin activation HTTP ${activated.status}`));
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
  return Effect.runPromise(verifyOpenCodeReadyEffect(endpoint, authorization, diagnostics), { signal });
}

function connection(endpoint: Endpoint, authorization?: string): Connection {
  return { url: endpoint.url, async fetch(input, init) {
    const request = new Request(input instanceof Request ? input : new URL(String(input), endpoint.url), init);
    const headers = new Headers(request.headers);
    if (authorization) headers.set('authorization', authorization);
    return endpoint.fetch(request.url, { method: request.method, headers, signal: request.signal,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer() });
  } };
}

/** Prepared Vite + pinned OpenCode orchestration over the existing workspace API. */
export function createBrowserEditorRecipe(options: { base?: string; model?: string } = {}) {
  if (options.model && options.model !== 'opencode/' + openCodeCandidateLaunch.model.id) throw Error('Browser editor requires the qualified OpenCode Muse Spark model');
  const base = options.base ?? '/editor/';
  return { async start(controller: WorkspaceController) {
    const diagnostics = createDiagnosticScope(event => controller.diagnostic(event.event, event.data), controller.diagnosticRunId);
    let manifest!: PreparedManifest, distribution!: Distribution;
    await controller.steps([
      ['Load editor preparation', async () => {
        manifest = await loadPrepared(base + 'prepared/', controller.signal, diagnostics);
        const response = await diagnostics.stage('runtime.manifest.fetch', () => fetch(base + 'runtime/distribution.json', { signal: controller.signal, headers: { 'x-editor-run-id': diagnostics.runId } }));
        if (!response.ok) throw Error(`Runtime unavailable: HTTP ${response.status}`);
        const runtime = await response.json();
        if (runtime.version !== manifest.runtimeVersion) throw Error('Prepared runtime version mismatch');
        distribution = { name: 'vivari', version: runtime.version, assetBaseUrl: base + 'runtime/' };
      }],
      ['Open local workspace', async () => { await controller.open(distribution); }],
      ['Seed missing application source', async () => {
        const workspace = controller.workspace!;
        controller.log(await diagnostics.stage('preview.cache.prepare', () => preparePreviewCache(workspace, JSON.stringify([manifest.runtimeVersion, manifest.bundle?.sha256 ?? manifest.assets]))));
        const existing = new Set(await diagnostics.stage('workspace.source.scan', () => sourcePaths(workspace)));
        for (const [path, text] of Object.entries(manifest.project)) {
          if (existing.has(path)) continue;
          await workspace.fs.mkdir(path.slice(0, path.lastIndexOf('/')) || '/');
          await workspace.fs.writeFile(path, decodeProjectFile(text));
        }
        for (const directory of openCodeCandidateLaunch.workspaceDirectories) await workspace.fs.mkdir(directory);
        await workspace.fs.writeFile(openCodeCandidateLaunch.workspaceConfigPath, JSON.stringify(createOpenCodeCandidateConfig(
          `http://host.vivari.internal:${location.port || (location.protocol === 'https:' ? '443' : '80')}${base}model/opencode/`, ['shell'])));
        await diagnostics.stage('workspace.seed.flush', () => workspace.flush());
      }],
      ['Start runtime and deliver verified applications', async () => {
        if (!controller.runtime) {
          const runtime = await diagnostics.stage('runtime.start', () => controller.startRuntime({ apps: preparedApps(manifest, base + 'prepared/', controller.signal, controller.log, diagnostics) }));
          try { await diagnostics.stage('runtime.apps.deliver', () => runtime.tools.apps()); }
          catch (error) { await controller.stopRuntime(); throw error; }
        }
      }],
      ['Start application preview and OpenCode', async () => {
        const started = performance.now();
        const preview = async () => {
          await controller.launch('vite', manifest.preview, 5173, async endpoint => {
            const response = await diagnostics.stage('preview.http', () => endpoint.fetch('/', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) }));
            if (!response.ok) throw Error(`Preview HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`);
            return connection(endpoint);
          });
          await diagnostics.stage('preview.client', () => controller.waitForClient('vite'));
          diagnostics.record('preview.usable', { elapsedMs: Math.round(performance.now() - started) });
          await diagnostics.stage('preview.flush', () => controller.workspace!.flush());
          controller.log(`Application preview ready (${Math.round(performance.now() - started)}ms)`);
        };
        const chat = async () => {
          const password = crypto.randomUUID() + crypto.randomUUID();
          const authorization = 'Basic ' + btoa('opencode:' + password);
          await controller.launch('chat', createOpenCodeCandidateLaunch({ password, ripgrepBinDirectory: manifest.opencode.support.binDirectory }), openCodeCandidateLaunch.port, async endpoint => {
            await verifyOpenCodeReady(endpoint, authorization, controller.signal, diagnostics);
            return connection(endpoint, authorization);
          }, { shutdown: 'stdin-eof', timeoutMs: 10000 });
          await diagnostics.stage('chat.client', () => controller.waitForClient('chat'));
          diagnostics.record('chat.usable', { elapsedMs: Math.round(performance.now() - started) });
          controller.log(`OpenCode ready (${Math.round(performance.now() - started)}ms)`);
        };
        // Both services depend on delivery, not on each other. Drain both starts
        // on failure so a retry never races an unfinished launch from this step.
        const results = await Promise.allSettled([preview(), chat()]);
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      }],
    ]);
    controller.status('Ready. Ask the agent to change the app; changes stay local to this browser.');
  } };
}
