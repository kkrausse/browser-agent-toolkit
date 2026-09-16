import { expect, test } from 'bun:test';
import { createOpenCodeCandidateConfig, createOpenCodeCandidateLaunch, openCodeCandidateLaunch } from '../src/opencode-launch';

test('candidate uses ordinary unchanged server launch and qualified environment', () => {
  const password = crypto.randomUUID();
  const launch = createOpenCodeCandidateLaunch({ password });
  expect(launch).toEqual({ entry: '/bin/bun.js', args: ['/app/server.js'], cwd: '/app', env: {
    PATH: '/direct/node_modules/.bin:/bin', RIPGREP_NODE_WASI: '0',
    HOME: '/workspace/.server/home', OPENCODE_TEST_HOME: '/workspace/.server/home',
    XDG_CONFIG_HOME: '/workspace/.server/config', XDG_STATE_HOME: '/workspace/.server/state',
    XDG_DATA_HOME: '/workspace/.server/data', XDG_CACHE_HOME: '/workspace/.server/cache', TMPDIR: '/workspace/.server/tmp',
    OPENCODE_PASSWORD: password, OPENCODE_TREE_SITTER_WASM_PATH: '/app/tree-sitter.wasm',
    OPENCODE_TREE_SITTER_BASH_WASM_PATH: '/app/tree-sitter-bash.wasm',
    OPENCODE_TREE_SITTER_POWERSHELL_WASM_PATH: '/app/tree-sitter-powershell.wasm',
  } });
  expect(createOpenCodeCandidateLaunch({ password, ripgrepBinDirectory: '/workspace/node_modules/.bin' }).env?.PATH).toBe('/workspace/node_modules/.bin:/bin');
});

test('explicit model config supplies catalog-absent Muse Spark via supported HTTP provider', () => {
  const baseURL = 'http://host.vivari.internal:5173/editor/model/';
  const config = createOpenCodeCandidateConfig(baseURL);
  expect(config.model).toBe('opencode/muse-spark-1.3-contributor-free');
  expect(config.$schema).toBe('https://opencode.ai/config.json');
  expect(config.snapshots).toBe(false);
  expect(config.providers.opencode.settings).toEqual({ baseURL });
  expect(config.providers.opencode.models[openCodeCandidateLaunch.model.id]).toEqual({
    name: 'Muse Spark 1.3 Free', package: '@opencode/ai/providers/openai',
    capabilities: { tools: true, input: ['text', 'image', 'video', 'pdf', 'audio'], output: ['text'] },
    limit: { context: 1048576, output: 131072 }, websocket: false,
  });
  expect(config.permissions).toEqual(['read', 'edit', 'grep', 'glob'].map(action => ({ action, resource: '*', effect: 'allow' })));
  expect(createOpenCodeCandidateConfig(baseURL, ['shell', 'read']).permissions.map(p => p.action)).toEqual(['read', 'edit', 'grep', 'glob', 'shell']);
});

test('descriptor exposes global config, fixed database, activation barrier and EOF lifecycle', () => {
  expect(openCodeCandidateLaunch.configPath).toBe('/workspace' + openCodeCandidateLaunch.workspaceConfigPath);
  expect(openCodeCandidateLaunch.projectConfig).toBe(false);
  expect(openCodeCandidateLaunch.databasePath).toBe('/runtime-probe/opencode.sqlite');
  expect(openCodeCandidateLaunch.guestDirectories).toContain('/runtime-probe');
  expect(openCodeCandidateLaunch.activation).toEqual({ method: 'POST', path: '/api/plugin/await-activation?directory=/workspace' });
  expect(openCodeCandidateLaunch.shutdown).toBe('stdin-eof');
  expect(openCodeCandidateLaunch.port).toBe(4096);
});

test('rejects embedded credentials and malformed launch inputs', () => {
  expect(() => createOpenCodeCandidateConfig('https://user:password@example.test')).toThrow('credential-free');
  expect(() => createOpenCodeCandidateConfig('file:///model')).toThrow('HTTP');
  expect(() => createOpenCodeCandidateLaunch({ password: '' })).toThrow('password');
  expect(() => createOpenCodeCandidateLaunch({ password: crypto.randomUUID(), ripgrepBinDirectory: '/bin:/other' })).toThrow('bin directory');
});
