import { resolve, join } from 'node:path';
import { readQualifiedOpenCodeApplication } from '../opencode-chat/src/opencode-application';

const source = process.argv[2];
if (!source) throw new Error('Usage: bun scripts/import-opencode.ts /path/to/integration/vivari');
const application = await readQualifiedOpenCodeApplication(resolve(source, '.runtime/opencode-release-2.0.3'));
const destination = resolve(import.meta.dirname, '../vivari/.runtime/opencode-release-2.0.3');
await Bun.write(join(destination, 'build-receipt.json'), application.receiptBytes);
for (const asset of application.assets) {
  await Bun.write(join(destination, '.runtime/opencode-bun-server', asset.file), asset.bytes);
}
console.log(`Imported verified OpenCode application to ${destination}`);
