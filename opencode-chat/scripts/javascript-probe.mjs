import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runHeadlessProcessProbe } from '../../vivari/scripts/headless-process-probe.mjs';

const directory = process.argv[2];
const require = createRequire(import.meta.url);
const typescript = dirname(require.resolve('typescript/package.json'));
const result = await runHeadlessProcessProbe({ directory, name: 'javascript-tool', timeoutMs: 120000,
  exercise: async api => {
    const files = [
      { path: '/workspace/probe.mjs', bytes: readFileSync(join(directory, 'guest.js')) },
      { path: '/workspace/package.json', bytes: Buffer.from('{"name":"guest-fixture","type":"module"}') },
      { path: '/workspace/helper.mjs', bytes: Buffer.from('export const value = 42;') },
      { path: '/workspace/check.ts', bytes: Buffer.from('const answer: number = 42;') },
      { path: '/workspace/node_modules/probe-wasm/package.json', bytes: Buffer.from('{"name":"probe-wasm","type":"module","exports":"./index.js"}') },
      { path: '/workspace/node_modules/probe-wasm/index.js', bytes: Buffer.from(`export async function add(a,b) { const {instance} = await WebAssembly.instantiate(Uint8Array.from([0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,3,2,1,0,7,7,1,3,97,100,100,0,0,10,9,1,7,0,32,0,32,1,106,11])); return instance.exports.add(a,b); }`) },
      ...['package.json', 'bin/tsc', 'lib/tsc.js', 'lib/_tsc.js', 'lib/typescript.js', 'lib/lib.es5.d.ts', 'lib/lib.decorators.d.ts', 'lib/lib.decorators.legacy.d.ts'].map(file => ({
        path: '/workspace/node_modules/typescript/' + file, bytes: readFileSync(join(typescript, file)),
      })),
    ];
    await api.kernel.writeFilesBatch(files);
    api.launch('/bin/node.js', ['/workspace/probe.mjs'], { cwd: '/workspace', env: { BROWSER_AGENT_GUEST: '1' } });
    await api.waitForOutput('stdout', 'JAVASCRIPT_GUEST_PASS');
    await api.waitForExit();
  },
});
console.log(JSON.stringify({ result: result.receipt.result, receiptPath: result.receiptPath, failure: result.receipt.primaryFailure }));
if (result.receipt.result !== 'PASS') console.error(readFileSync(join(result.receipt.root, 'stderr.bin'), 'utf8'));
assert.equal(result.receipt.result, 'PASS');
