// Explicit checkout setup; normal builds never clone, checkout, reset or apply patches.
import { existsSync } from 'node:fs';
import { integrationRoot, resolveRuntimeSource, runtimeConfig } from './runtime-source.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: bun scripts/setup-runtime.ts\nClone runtime-source.json repository at its recorded revision into the sibling fork (or VIVARI_SOURCE). Existing paths are never changed. Then run bun scripts/build-runtime.ts.');
  process.exit(0);
}
if (args.length) throw new Error('Unexpected arguments; see --help');
const source = resolveRuntimeSource();
if (existsSync(source)) throw new Error(`Checkout path already exists: ${source}. Use it with build-runtime.ts; setup never modifies existing paths.`);
function run(args: string[], cwd: string) {
  console.log('$', args.join(' '));
  const result = Bun.spawnSync(args, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if (result.exitCode !== 0) throw new Error(`Failed (${result.exitCode}): ${args.join(' ')}`);
}
run(['git', 'clone', '--no-checkout', runtimeConfig.repository, source], integrationRoot);
run(['git', 'checkout', '-B', runtimeConfig.branch, runtimeConfig.revision], source);
run(['git', 'remote', 'add', 'upstream', runtimeConfig.upstream], source);
console.log(`Ready: ${source} at ${runtimeConfig.revision}. Run bun scripts/build-runtime.ts.`);
