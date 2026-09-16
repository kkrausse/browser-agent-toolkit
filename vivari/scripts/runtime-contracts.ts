// Run the fork-owned contracts with a real Node >=24 host (NODE_BINARY overrides PATH).
import { runtimeSourcePath, resolveRuntimeSource } from './runtime-source.mjs';

const child = Bun.spawn([process.env.NODE_BINARY || 'node', runtimeSourcePath('scripts/verify-runtime-contracts.mjs'), ...process.argv.slice(2)], {
  cwd: resolveRuntimeSource(), stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
});
process.exitCode = await child.exited;
