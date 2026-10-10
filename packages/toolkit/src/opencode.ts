import type { RuntimeEndpoint, RuntimeFs } from './runtime-host';
import { toLaunch, type LaunchDescription } from './manifest';
import type { Launch } from './runtime-host';
import type { CatalogModel } from './model-catalog';
import { modelHeaderPluginSource } from './model-headers';
import { javascriptPluginSource } from './guest/javascript-plugin-source' with { type: 'macro' };

// Bundled at build time (Bun macro): the guest plugin with its Effect runtime, one ESM string.
const javascriptPlugin: string = javascriptPluginSource() as unknown as string;

const workspace = '/workspace';
const server = `${workspace}/.server`;
const configDirectory = `${server}/config/opencode`;
const locationQuery = new URLSearchParams({ 'location[directory]': workspace }).toString();

/** Everything fixed about the pinned OpenCode 2.0.3 server artifact. */
export const openCode = {
  port: 4096,
  directory: workspace,
  /** Used when the host supplies no catalog. */
  model: { providerID: 'opencode', id: 'muse-spark-1.3-contributor-free' },
  configPath: `${configDirectory}/opencode.json`,
  directories: ['home', 'config/opencode/plugins', 'state', 'data', 'cache', 'tmp'].map(name => `${server}/${name}`),
} as const;

const fallbackModel: CatalogModel = {
  name: 'Muse Spark 1.3 Free', package: '@opencode/ai/providers/openai',
  capabilities: { tools: true, input: ['text', 'image', 'video', 'pdf', 'audio'], output: ['text'] },
  limit: { context: 1048576, output: 131072 }, websocket: false,
};

/** Used when the manifest carries no agent launch (a manifest written without the image). */
export const defaultAgent: LaunchDescription = {
  entry: '/app/server.js', cwd: '/app', port: openCode.port, programs: ['opencode-server'],
  env: {
    PATH: '/app/node_modules/.bin:/bin',
    HOME: `${server}/home`, OPENCODE_TEST_HOME: `${server}/home`,
    XDG_CONFIG_HOME: `${server}/config`, XDG_STATE_HOME: `${server}/state`,
    XDG_DATA_HOME: `${server}/data`, XDG_CACHE_HOME: `${server}/cache`, TMPDIR: `${server}/tmp`,
    OPENCODE_TREE_SITTER_WASM_PATH: '/app/tree-sitter.wasm',
    OPENCODE_TREE_SITTER_BASH_WASM_PATH: '/app/tree-sitter-bash.wasm',
    OPENCODE_TREE_SITTER_POWERSHELL_WASM_PATH: '/app/tree-sitter-powershell.wasm',
  },
};

/** The Node-target bundle, started as a Node program (`node /app/server.js`). It listens on
 * 127.0.0.1:4096 with Basic auth and shuts down on stdin EOF. The prepared description
 * supplies paths; the per-start secret and the workspace-owned locations are added here. */
export function agentLaunch(password: string, description: LaunchDescription = defaultAgent): Launch {
  if (!password || /[^\x20-\x7e]/.test(password)) throw Error('Expected a nonempty ASCII server password');
  const launch = toLaunch(description, {
    EDITOR_WORKSPACE: workspace,
    OPENCODE_PASSWORD: password,
    // In the workspace, so sessions persist with it (the old runtime kept it outside).
    OPENCODE_DATABASE_PATH: `${server}/data/opencode.sqlite`,
  });
  // Loaded before the server (see `modelSourcePreloadSource`); a separate argument, so a host
  // that maps guest paths (the development fake host) maps this one too.
  return { ...launch, argv: [launch.argv[0]!, '--require', modelSourcePreload, ...launch.argv.slice(1)] };
}

/** Global configuration: one provider that is the host's model proxy; an explicit default
 * selects only the supplied catalog. */
export function agentConfig(modelBaseURL: string, models: Record<string, CatalogModel> = {}, defaultModel?: string) {
  const url = new URL(modelBaseURL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Expected credential-free HTTP model proxy URL');
  if (defaultModel !== undefined && !Object.hasOwn(models, defaultModel)) throw Error('Default model is absent from the supplied catalog');
  return {
    $schema: 'https://opencode.ai/config.json',
    model: 'opencode/' + (defaultModel ?? openCode.model.id), snapshots: false,
    permissions: ['read', 'edit', 'grep', 'glob', 'runJavascript'].map(action => ({ action, resource: '*', effect: 'allow' as const })),
    // This is a host-authenticated proxy, not a direct Zen connection. The host
    // replaces authorization; this public routing marker is never a credential.
    // Zen otherwise disables paid models solely because the guest has no key.
    providers: { opencode: { activation: 'enabled' as const, settings: { baseURL: modelBaseURL, apiKey: 'editor-host-proxy' }, models: {
      ...(defaultModel === undefined ? { [openCode.model.id]: fallbackModel } : {}),
      // Zen's pre-plugin can disable its paid catalog before the post-plugin
      // applies this host-proxy config. Omission retains that disabled state.
      ...Object.fromEntries(Object.entries(models).map(([id, model]) => [id, { disabled: false, ...model }])),
    } } },
  };
}

/** The guest's own catalog also lists every free model its provider publishes. Global
 * plugins run after that catalog is loaded and before the configuration is applied, so
 * removing the rest leaves exactly the supplied catalog. */
export function modelCatalogPluginSource(modelIDs: string[]): string {
  return `export default { id: 'editor.model-catalog', async setup(ctx) {
  const supplied = new Set(${JSON.stringify(modelIDs)});
  await ctx.catalog.transform(catalog => {
    for (const id of [...(catalog.provider.get('opencode')?.models.keys() ?? [])]) if (!supplied.has(id)) catalog.model.remove('opencode', id);
  });
} };`;
}

const modelSourcePreload = `${server}/editor-model-source.cjs`;
/**
 * OpenCode builds its catalog from the models.dev document: 226 providers and about 4,000
 * models, 5.4 MB, fetched at every start older than five minutes, stored as one database
 * row and copied model by model into the catalog while plugins activate. The editor has one
 * provider (the host's proxy, id `opencode`), and the server's own `/api/model` lists only
 * that provider's models either way. This preload (`node --require`) answers the server's
 * catalog request with the upstream document reduced to that provider, so the stored row is
 * about 2% of the size and a start no longer normalizes and copies models nobody can use.
 * A workspace's first start still builds from the catalog bundled in the server; the
 * reduced document replaces it at the first refresh. Measured in
 * docs/experiments/2026-10-09-startup.md.
 */
export function modelSourcePreloadSource(providers: string[] = ['opencode']): string {
  return `'use strict';
const source = 'https://models.opencode.ai/api.json';
const keep = ${JSON.stringify(providers)};
const upstream = globalThis.fetch;
let said = false;
globalThis.fetch = async function (input, init) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
  if (url !== source) return upstream.call(this, input, init);
  const response = await upstream.call(this, input, init);
  if (!response.ok) return response;
  const catalog = await response.json();
  const reduced = {};
  for (const id of keep) if (Object.hasOwn(catalog, id)) reduced[id] = catalog[id];
  const text = JSON.stringify(reduced);
  if (!said) { said = true; console.error('[editor] model catalog source reduced to ' + Object.keys(reduced).length + ' of ' + Object.keys(catalog).length + ' providers, ' + text.length + ' bytes'); }
  return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
};
`;
}

/** Write only when the content differs: every write is journaled for the next open to replay. */
async function writeText(fs: RuntimeFs, path: string, text: string) {
  const have = await fs.readFile(path).then(bytes => new TextDecoder().decode(bytes), () => undefined);
  if (have !== text) await fs.writeFile(path, text);
}

/** Write OpenCode's directories, plugins and global configuration. Nothing else in the workspace is touched. */
export async function installAgentConfig(fs: RuntimeFs, options: { modelBaseURL: string; models?: Record<string, CatalogModel>; defaultModel?: string }) {
  for (const directory of openCode.directories) await fs.mkdir(directory);
  // The agent's state lives inside the workspace. Tools that scan the project by its
  // ignore rules must not see it: Tailwind's Vite plugin scans every unignored file and
  // answers a change to a scanned non-module file with a full page reload, so each
  // database or log write of the agent reloaded the preview (three times per chat turn).
  await writeText(fs, `${server}/.gitignore`, '*\n');
  const plugins = `${configDirectory}/plugins`;
  await writeText(fs, `${plugins}/editor-model-headers.js`, modelHeaderPluginSource(options.modelBaseURL));
  await writeText(fs, `${plugins}/editor-javascript.js`, javascriptPlugin);
  // An explicit default means the host owns the whole catalog. The workspace persists
  // between visits, so a previous visit's catalog plugin must not survive.
  if (options.defaultModel !== undefined) await writeText(fs, `${plugins}/editor-model-catalog.js`, modelCatalogPluginSource(Object.keys(options.models ?? {})));
  else await fs.remove(`${plugins}/editor-model-catalog.js`);
  await writeText(fs, modelSourcePreload, modelSourcePreloadSource());
  await writeText(fs, openCode.configPath, JSON.stringify(agentConfig(options.modelBaseURL, options.models, options.defaultModel)));
}

const timed = (name: string) => { try { performance.mark(`bat:${name}`); } catch { /* no user timing */ } };

type PluginRow = { id: string; state?: { status: string } };

/** Health, plugin activation, then proof that the model the chat will use is offered with tools. */
export async function verifyAgentReady(endpoint: Pick<RuntimeEndpoint, 'fetch'>, authorization: string, signal: AbortSignal) {
  const request = (path: string, method = 'GET', timeout = 20000) =>
    endpoint.fetch(path, { method, headers: { authorization }, signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
  const json = async (path: string, what: string) => {
    const response = await request(path);
    if (!response.ok) { await response.arrayBuffer(); throw Error(`OpenCode ${what} HTTP ${response.status}`); }
    return response.json();
  };
  const deadline = Date.now() + 30000;
  let lastFailure: unknown = Error('OpenCode health not ready');
  for (;;) {
    signal.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error('OpenCode health readiness timed out after 30000ms', { cause: lastFailure });
    try {
      const health = await request('/api/health', 'GET', Math.min(3000, remaining));
      await health.arrayBuffer();
      if (health.ok) { timed('agent.health'); break; }
      lastFailure = Error(`OpenCode health HTTP ${health.status}`);
    } catch (error) { lastFailure = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const activated = await request(`/api/plugin/await-activation?${locationQuery}`, 'POST');
  await activated.arrayBuffer();
  if (!activated.ok) throw Error(`OpenCode plugin activation HTTP ${activated.status}`);
  timed('agent.activated');
  const plugins = await json(`/api/plugin?${locationQuery}`, 'plugins');
  const active = (id: string) => Array.isArray(plugins.data) && plugins.data.some((plugin: PluginRow) => plugin.id === id && plugin.state?.status === 'active');
  if (!active('editor.model-headers')) throw Error('OpenCode model header transport plugin is not active');
  if (!active('editor.javascript')) throw Error('OpenCode guest JavaScript tool plugin is not active');
  timed('agent.plugins');
  const entries = await json(`/api/config?${locationQuery}`, 'configuration');
  const selected = Array.isArray(entries) && entries.find(entry => entry.type === 'document' && entry.path === openCode.configPath);
  // The config API returns the decoded model selection, even when the JSON
  // document uses the shorthand string (which older responses may preserve).
  const selection = selected?.info?.model;
  const modelID = typeof selection === 'string'
    ? (selection.startsWith('opencode/') ? selection.slice('opencode/'.length) : undefined)
    : selection?.providerID === 'opencode' ? selection.model : undefined;
  const configured = modelID && selected.info?.providers?.opencode?.models?.[modelID];
  if (!configured || typeof configured.package !== 'string' || configured.websocket !== false) throw Error('OpenCode global model configuration not loaded');
  timed('agent.config');
  const { data } = await json(`/api/model?${locationQuery}`, 'model catalog');
  // Startup tracing (see the runtime's trace.ts): the catalog as served, for comparing runs.
  if ((globalThis as { __batTrace?: unknown }).__batTrace) (globalThis as { __batAgentModels?: unknown }).__batAgentModels = data;
  const model = Array.isArray(data) && data.find(item => item.providerID === 'opencode' && item.id === modelID);
  if (!model?.enabled || !model.capabilities?.tools) throw Error(`OpenCode model ${modelID} is not enabled with tools (present: ${!!model})`);
}
