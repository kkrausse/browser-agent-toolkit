import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'javascript-guest-'));
const built = await Bun.build({ entrypoints: [join(import.meta.dir, '../test/javascript-guest.ts')], target: 'node', format: 'esm' });
if (!built.success) throw new AggregateError(built.logs);
await Bun.write(join(directory, 'guest.js'), await built.outputs[0]!.text());
const child = Bun.spawn(['bunx', '--package', 'node-bin-darwin-arm64@24.18.0', 'node', join(import.meta.dir, 'javascript-probe.mjs'), directory], { stdout: 'inherit', stderr: 'inherit' });
process.exitCode = await child.exited;
