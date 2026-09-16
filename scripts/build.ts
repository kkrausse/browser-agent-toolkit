import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
async function run(directory: string, ...args: string[]) {
  const child = Bun.spawn(['bun', ...args], {
    cwd: resolve(root, directory), stdout: 'inherit', stderr: 'inherit',
  });
  if (await child.exited) throw new Error(`Failed in ${directory}: bun ${args.join(' ')}`);
}
const install = process.argv.includes('--install');
const example = process.argv.includes('--example') || process.argv.includes('--dev') || install;
if (install) await run('workspace-api', 'install', '--frozen-lockfile');
await run('workspace-api', 'run', 'build');
// Bun file dependencies can be copied/cached. Refresh explicitly so each build
// consumes this checkout's latest output without a version bump.
await run('opencode-chat', 'install', '--force', '--linker', 'isolated', '--frozen-lockfile');
await run('opencode-chat', 'run', 'build');
if (example) {
  await run('examples/todo-app', 'install', '--force', '--linker', 'isolated', '--frozen-lockfile');
  await run('examples/todo-app', 'run', process.argv.includes('--dev') ? 'dev' : 'build');
}
