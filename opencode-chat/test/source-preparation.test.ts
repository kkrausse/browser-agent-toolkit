import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeBrowserEditorSource } from '../src/prepare';

test('source refresh replaces only host delivery and leaves managed build inputs intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'editor-source-preparation-'));
  try {
    const app = join(root, 'app'), output = join(root, 'output');
    await mkdir(join(app, 'src'), { recursive: true });
    await mkdir(join(output, 'prepared'), { recursive: true });
    await writeFile(join(app, 'src/app.ts'), 'new source');
    await writeFile(join(output, 'prepared/manifest.json'), JSON.stringify({
      format: 'browser-editor-v2',
      project: { '/package.json': 'managed manifest', '/src/app.ts': 'old source', '/removed.ts': 'old' },
    }));
    await writeBrowserEditorSource({ appRoot: app, output, source: ['src'] });
    const manifest = JSON.parse(await readFile(join(output, 'prepared/manifest.json'), 'utf8'));
    expect(manifest.project).toEqual({ '/package.json': 'managed manifest', '/src/app.ts': 'new source' });
    expect(manifest.sourcePaths).toEqual(['src']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
