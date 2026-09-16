import type { NodeLaunchOptions } from '@kev-browser-agent-kit/workspace';

/** Browser-safe exact candidate contract. Host filesystem verification lives separately. */
export const openCodeCandidateLaunch = {
  format: 'opencode-server-process-v1',
  candidate: 'opencode-server-process-2.0.3',
  receiptSha256: 'df6a3d88f014f95c1dd5957a06c6e3baa3ca4d4dd45ca4be5ea88d6518627813',
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
  activation: { method: 'POST', path: '/api/plugin/await-activation?directory=/workspace' },
  modelPath: '/api/model?directory=/workspace',
  configAPIPath: '/api/config?directory=/workspace',
  readyMarker: 'OPENCODE_SERVER_PROCESS_READY',
  shutdownMarker: 'OPENCODE_SERVER_PROCESS_SHUTDOWN_COMPLETE',
  shutdown: 'stdin-eof',
} as const;

/** Match the qualified global configuration; caller supplies its transparent model proxy. */
export function createOpenCodeCandidateConfig(modelBaseURL: string, additionalToolActions: string[] = []) {
  const url = new URL(modelBaseURL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Expected credential-free HTTP model proxy URL');
  return {
    $schema: 'https://opencode.ai/config.json',
    model: 'opencode/' + openCodeCandidateLaunch.model.id, snapshots: false,
    permissions: [...new Set(['read', 'edit', 'grep', 'glob', ...additionalToolActions])].map(action => ({ action, resource: '*', effect: 'allow' as const })),
    providers: { opencode: { settings: { baseURL: modelBaseURL }, models: {
      [openCodeCandidateLaunch.model.id]: { name: 'Muse Spark 1.3 Free', package: '@opencode/ai/providers/openai',
        capabilities: { tools: true, input: ['text', 'image', 'video', 'pdf', 'audio'], output: ['text'] },
        limit: { context: 1048576, output: 131072 }, websocket: false },
    } } },
  };
}

/** Requires normally installed ripgrep@0.3.1 (including its executable link). */
export function createOpenCodeCandidateLaunch(options: { password: string; ripgrepBinDirectory?: string }): NodeLaunchOptions {
  if (!options.password || /[^\x20-\x7e]/.test(options.password)) throw Error('Expected a nonempty ASCII server password');
  const bin = options.ripgrepBinDirectory ?? '/direct/node_modules/.bin';
  if (!/^\/(?:[\w@.-]+\/)*[\w@.-]+$/.test(bin) || bin.split('/').some(p => p === '.' || p === '..')) throw Error('Invalid ripgrep bin directory');
  return { entry: '/bin/bun.js', args: ['/app/server.js'], cwd: '/app', env: {
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
