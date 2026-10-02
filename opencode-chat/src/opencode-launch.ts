import type { NodeLaunchOptions } from '@kev-browser-agent-kit/workspace';

const workspaceLocationQuery = new URLSearchParams({ 'location[directory]': '/workspace' }).toString();

/** Browser-safe exact candidate contract. Host filesystem verification lives separately. */
export const openCodeCandidateLaunch = {
  format: 'opencode-server-process-v1',
  candidate: 'opencode-server-process-2.0.3',
  receiptSha256: '40789e37d00c5bfbfc9dad88012d7fe3c88a6054df7a2cbd340e1bd2bd676112',
  sourceRevision: 'd44b52ca66b6bf69626c0384626d1a9cd9555977',
  port: 4096,
  databasePath: '/runtime-probe/opencode.sqlite',
  projectConfig: false,
  model: { providerID: 'opencode', id: 'muse-spark-1.3-contributor-free' },
  configPath: '/workspace/.server/config/opencode/opencode.json',
  workspaceConfigPath: '/.server/config/opencode/opencode.json',
  workspaceDirectories: ['/.server/home', '/.server/config/opencode', '/.server/state', '/.server/data', '/.server/cache', '/.server/tmp'],
  guestDirectories: ['/runtime-probe'],
  healthPath: '/api/health',
  activation: { method: 'POST', path: `/api/plugin/await-activation?${workspaceLocationQuery}` },
  pluginPath: `/api/plugin?${workspaceLocationQuery}`,
  modelPath: `/api/model?${workspaceLocationQuery}`,
  configAPIPath: `/api/config?${workspaceLocationQuery}`,
  readyMarker: 'OPENCODE_SERVER_PROCESS_READY',
  shutdownMarker: 'OPENCODE_SERVER_PROCESS_SHUTDOWN_COMPLETE',
  shutdown: 'stdin-eof',
} as const;

export type OpenCodeCandidateModel = {
  disabled?: boolean;
  name: string;
  package: '@opencode/ai/providers/openai' | '@opencode/ai/providers/anthropic' | '@opencode/ai/providers/openai-compatible';
  capabilities: { tools: boolean; input: string[]; output: string[] };
  limit: { context: number; input?: number; output: number };
  websocket: false;
};

const fallbackModel: OpenCodeCandidateModel = {
  name: 'Muse Spark 1.3 Free', package: '@opencode/ai/providers/openai',
  capabilities: { tools: true, input: ['text', 'image', 'video', 'pdf', 'audio'], output: ['text'] },
  limit: { context: 1048576, output: 131072 }, websocket: false,
};

/** Match the qualified global configuration; an explicit default selects only the supplied catalog. */
export function createOpenCodeCandidateConfig(modelBaseURL: string, additionalToolActions: string[] = [], models: Record<string, OpenCodeCandidateModel> = {}, defaultModel?: string) {
  const url = new URL(modelBaseURL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Expected credential-free HTTP model proxy URL');
  if (defaultModel !== undefined && !Object.hasOwn(models, defaultModel)) throw Error('Default model is absent from the supplied catalog');
  return {
    $schema: 'https://opencode.ai/config.json',
    model: 'opencode/' + (defaultModel ?? openCodeCandidateLaunch.model.id), snapshots: false,
    permissions: [...new Set(['read', 'edit', 'grep', 'glob', 'runJavascript', ...additionalToolActions])].map(action => ({ action, resource: '*', effect: 'allow' as const })),
    // This is a host-authenticated proxy, not a direct Zen connection. The host
    // replaces authorization; this public routing marker is never a credential.
    // Zen otherwise disables paid models solely because the guest has no key.
    providers: { opencode: { activation: 'enabled' as const, settings: { baseURL: modelBaseURL, apiKey: 'editor-host-proxy' }, models: {
      ...(defaultModel === undefined ? { [openCodeCandidateLaunch.model.id]: fallbackModel } : {}),
      // Zen's pre-plugin can disable its paid catalog before the post-plugin
      // applies this host-proxy config. Omission retains that disabled state.
      // Explicit availability is owned by the supplied catalog, not guest auth.
      ...Object.fromEntries(Object.entries(models).map(([id, model]) => [id, { disabled: false, ...model }])),
    } } },
  };
}

/** Public model selection supplied by the host: never a credential, and the only models the editor offers. */
export interface OpenCodeModelCatalog { models: Record<string, OpenCodeCandidateModel>; defaultModel: string }

const catalogModelFields = ['disabled', 'name', 'package', 'capabilities', 'limit', 'websocket'];
const catalogPackages = ['@opencode/ai/providers/openai', '@opencode/ai/providers/anthropic', '@opencode/ai/providers/openai-compatible'];
const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');
const size = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;

/** Validate an untrusted catalog document (e.g. a JSON file) before it is delivered to browsers and guests. */
export function parseOpenCodeModelCatalog(input: unknown): OpenCodeModelCatalog {
  const catalog = input as Partial<OpenCodeModelCatalog> | null;
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw Error('Model catalog must be an object with models and defaultModel');
  if (typeof catalog.defaultModel !== 'string' || !catalog.defaultModel) throw Error('Explicit catalog requires a default model');
  const models = catalog.models;
  if (!models || typeof models !== 'object' || Array.isArray(models) || !Object.keys(models).length) throw Error('Model catalog requires at least one model');
  for (const [id, model] of Object.entries(models) as [string, Record<string, unknown> | null][]) {
    const invalid = (reason: string) => Error(`Model catalog entry ${JSON.stringify(id.slice(0, 100))}: ${reason}`);
    if (!/^[\w./:-]{1,128}$/.test(id)) throw invalid('invalid model identifier');
    if (!model || typeof model !== 'object' || Array.isArray(model)) throw invalid('expected an object');
    // The catalog is published to the browser and the guest. Settings, headers
    // and bodies could carry credentials, so only the public fields are accepted.
    const unknown = Object.keys(model).find(field => !catalogModelFields.includes(field));
    if (unknown) throw invalid(`unsupported field ${JSON.stringify(unknown.slice(0, 100))}`);
    if (typeof model.name !== 'string' || !model.name) throw invalid('expected a name');
    if (!catalogPackages.includes(model.package as string)) throw invalid('unsupported provider package');
    const capabilities = model.capabilities as Record<string, unknown> | undefined, limit = model.limit as Record<string, unknown> | undefined;
    if (typeof capabilities?.tools !== 'boolean' || !strings(capabilities.input) || !strings(capabilities.output)) throw invalid('expected capabilities {tools, input, output}');
    if (!size(limit?.context) || !size(limit?.output) || (limit?.input !== undefined && !size(limit.input))) throw invalid('expected limit {context, input?, output}');
    if (model.websocket !== false) throw invalid('expected websocket: false');
    if (model.disabled !== undefined && typeof model.disabled !== 'boolean') throw invalid('expected a boolean disabled');
  }
  const { defaultModel } = catalog, supplied = models as Record<string, OpenCodeCandidateModel>;
  // The guest configuration is the authority for default/catalog consistency.
  createOpenCodeCandidateConfig('http://host/editor/model/opencode/', [], supplied, defaultModel);
  const selected = supplied[defaultModel]!;
  if (selected.disabled || !selected.capabilities.tools) throw Error('Default model must be enabled with tools');
  return { models: supplied, defaultModel };
}

/** The prepared manifest as delivered with a host-supplied catalog; generated preparation output is not rewritten. */
export function withOpenCodeModelCatalog<Manifest extends object>(manifest: Manifest, catalog: OpenCodeModelCatalog) {
  return { ...manifest, modelCatalog: catalog.models, editorDefaultModel: catalog.defaultModel };
}

/**
 * Self-contained JS for OpenCode's public global single-file plugin discovery.
 * The guest's own catalog also lists every free model its provider publishes.
 * Global plugins run after that catalog is loaded and before the configuration
 * above is applied, so removing the rest leaves exactly the supplied catalog.
 */
export function modelCatalogPluginSource(modelIDs: string[]): string {
  return `export default { id: 'editor.model-catalog', async setup(ctx) {
  const supplied = new Set(${JSON.stringify(modelIDs)});
  await ctx.catalog.transform(catalog => {
    for (const id of [...(catalog.provider.get('opencode')?.models.keys() ?? [])]) if (!supplied.has(id)) catalog.model.remove('opencode', id);
  });
} };`;
}

/**
 * Opt-in measurement entry (see opencode-trace-guest.cjs). The guest prints
 * `prefix` + one-line JSON on stdout and serves its full counters at `dumpPath`.
 */
export const openCodeTrace = {
  entry: '/workspace/.server/trace/opencode-trace.cjs',
  workspacePath: '/.server/trace/opencode-trace.cjs',
  workspaceDirectory: '/.server/trace',
  prefix: 'OPENCODE_TRACE ',
  dumpPath: '/__opencode_trace',
} as const;

/** Requires normally installed ripgrep@0.3.1 (including its executable link). `trace` launches the tracing entry instead of the server. */
export function createOpenCodeCandidateLaunch(options: { password: string; ripgrepBinDirectory?: string; trace?: boolean }): NodeLaunchOptions {
  if (!options.password || /[^\x20-\x7e]/.test(options.password)) throw Error('Expected a nonempty ASCII server password');
  const bin = options.ripgrepBinDirectory ?? '/direct/node_modules/.bin';
  if (!/^\/(?:[\w@.-]+\/)*[\w@.-]+$/.test(bin) || bin.split('/').some(p => p === '.' || p === '..')) throw Error('Invalid ripgrep bin directory');
  return { entry: '/bin/bun.js', args: [options.trace ? openCodeTrace.entry : '/app/server.js'], cwd: '/app', env: {
    PATH: bin + ':/bin', RIPGREP_NODE_WASI: '0',
    HOME: '/workspace/.server/home', OPENCODE_TEST_HOME: '/workspace/.server/home',
    XDG_CONFIG_HOME: '/workspace/.server/config', XDG_STATE_HOME: '/workspace/.server/state',
    XDG_DATA_HOME: '/workspace/.server/data', XDG_CACHE_HOME: '/workspace/.server/cache', TMPDIR: '/workspace/.server/tmp',
    OPENCODE_PASSWORD: options.password,
    OPENCODE_TREE_SITTER_WASM_PATH: '/app/tree-sitter.wasm',
    OPENCODE_TREE_SITTER_BASH_WASM_PATH: '/app/tree-sitter-bash.wasm',
    OPENCODE_TREE_SITTER_POWERSHELL_WASM_PATH: '/app/tree-sitter-powershell.wasm',
  } };
}
