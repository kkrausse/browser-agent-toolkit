import { createHash } from 'node:crypto';

// Generated upstream contract; review the diff and migrate consumers before promotion.
const revision = 'd44b52ca66b6bf69626c0384626d1a9cd9555977';
const expected = '9238842bf9d4dbef486f4c20fb4051a5ccb051a30a9d84a9d4267c089ef37fed';
const response = await fetch(`https://raw.githubusercontent.com/anomalyco/opencode/${revision}/packages/client/src/promise/generated/types.ts`);
if (!response.ok) throw Error(`Upstream contract HTTP ${response.status}`);
const bytes = new Uint8Array(await response.arrayBuffer());
if (createHash('sha256').update(bytes).digest('hex') !== expected) throw Error('Upstream contract integrity mismatch');
await Bun.write(new URL('../src/vendor/types.ts', import.meta.url), bytes);
console.log(`OpenCode 2.0.3 generated types: ${expected}`);
