// One-command local setup: pinned runtime checkout and build, the verified
// OpenCode and Tailwind prerequisites, then both packages and the example.
// Every step reuses existing output; nothing here resets a checkout.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveRuntimeSource } from '../vivari/scripts/runtime-source.mjs';

const root = resolve(import.meta.dirname, '..');
async function step(...args: string[]) {
  const started = performance.now();
  console.log(`\n$ bun ${args.join(' ')}`);
  const child = Bun.spawn(['bun', ...args], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited) throw new Error(`Setup failed: bun ${args.join(' ')}`);
  console.log(`(${((performance.now() - started) / 1000).toFixed(1)}s)`);
}
if (!existsSync(resolveRuntimeSource())) await step('vivari/scripts/setup-runtime.ts');
await step('vivari/scripts/build-runtime.ts');
await step('scripts/setup-opencode.ts');
await step('vivari/scripts/setup-tailwind-candidate.ts');
await step('scripts/build.ts', '--install');
