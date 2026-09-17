// Install exact published versions into an empty consumer, using caller-supplied auth.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw Error('Usage: bun scripts/verify-registry.ts <version>');
if (!process.env.NODE_AUTH_TOKEN) throw Error('Set NODE_AUTH_TOKEN to a GitHub token with read:packages (or the publishing workflow token)');
const root = await mkdtemp(join(process.env.RELEASE_SMOKE_TMP ?? tmpdir(), 'browser-agent-registry-'));
try {
  await Bun.write(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
    '@kkrausse/browser-agent-runtime': version,
    '@kev-browser-agent-kit/workspace': `npm:@kkrausse/browser-agent-workspace@${version}`,
    '@kev-browser-agent-kit/opencode-chat': `npm:@kkrausse/browser-agent-opencode-chat@${version}`,
    react: '19.2.4', 'react-dom': '19.2.4',
  } }, null, 2));
  await Bun.write(join(root, '.npmrc'), '@kkrausse:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n');
  const install = Bun.spawn(['bun', 'install', '--ignore-scripts'], {
    cwd: root, stdout: 'inherit', stderr: 'inherit',
    env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(root, 'cache') },
  });
  if (await install.exited) throw Error('Published package installation failed');
  await Bun.write(join(root, 'verify.tsx'), `
    import { dirname } from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { Workspace, WorkspaceError } from '@kev-browser-agent-kit/workspace';
    import { WorkspaceProvider } from '@kev-browser-agent-kit/workspace/react';
    import { readRuntimeAssets, readRuntimeBackendPolicy } from '@kev-browser-agent-kit/workspace/assets';
    import { createChatController } from '@kev-browser-agent-kit/opencode-chat';
    import { packagedOpenCodeDirectory } from '@kev-browser-agent-kit/opencode-chat/prepare';
    const runtime = dirname(fileURLToPath(import.meta.resolve('@kkrausse/browser-agent-runtime/distribution.json')));
    const assets = await readRuntimeAssets(runtime);
    await readRuntimeBackendPolicy(runtime);
    if (typeof Workspace.open !== 'function' || typeof createChatController !== 'function') throw Error('Missing public exports');
    if (new WorkspaceError('CLOSED', 'test').code !== 'CLOSED') throw Error('Missing workspace error');
    if (!renderToStaticMarkup(<WorkspaceProvider><p>registry consumer</p></WorkspaceProvider>).includes('registry consumer')) throw Error('SSR failed');
    if (!(await Bun.file(packagedOpenCodeDirectory + '/build-receipt.json').exists())) throw Error('Prepared OpenCode input missing');
    console.log(JSON.stringify({version: ${JSON.stringify(version)}, runtime: assets.version, registryInstall: 'PASS', ssr: 'PASS', preparedApplication: 'PASS'}));
  `);
  const smoke = Bun.spawn(['bun', 'verify.tsx'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  if (await smoke.exited) throw Error('Published package smoke failed');
} finally {
  await rm(root, { recursive: true, force: true });
}
