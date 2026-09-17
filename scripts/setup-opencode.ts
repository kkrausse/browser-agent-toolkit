// Fetch the exact prepared application already qualified in the browser.
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { readQualifiedOpenCodeApplication } from '../opencode-chat/src/opencode-application';

const root = resolve(import.meta.dir, '..');
const destination = resolve(root, 'vivari/.runtime/opencode-release-2.0.3');
const input = await Bun.file(resolve(root, 'vivari/opencode-input.json')).json();
if (existsSync(destination)) {
  await readQualifiedOpenCodeApplication(destination);
  console.log(`Qualified OpenCode input already present: ${destination}`);
} else {
  const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-opencode-'));
  try {
    const response = await fetch(input.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw Error(`OpenCode input download: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (new Bun.CryptoHasher('sha256').update(bytes).digest('hex') !== input.sha256) {
      throw Error('OpenCode input archive integrity failure');
    }
    const archive = join(temporary, 'input.tgz');
    const payload = join(temporary, 'payload');
    await Bun.write(archive, bytes);
    await mkdir(payload);
    const tar = Bun.spawn(['tar', '-xzf', archive, '-C', payload], { stdout: 'inherit', stderr: 'inherit' });
    if (await tar.exited) throw Error('OpenCode input extraction failed');
    await readQualifiedOpenCodeApplication(payload);
    await mkdir(resolve(destination, '..'), { recursive: true });
    await cp(payload, destination, { recursive: true, errorOnExist: true, force: false });
    console.log(`Installed qualified OpenCode input: ${destination}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
