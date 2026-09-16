import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparePreviewCache } from '../src/preview-cache';
import type { Workspace } from '@kev-browser-agent-kit/workspace';

test('preview cache survives matching preparation, invalidates changed and incomplete caches, preserves source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preview-cache-'));
  const path = (name: string) => root + name;
  const workspace = { fs: {
    stat: async (name: string) => { const s = await stat(path(name)); return { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size }; },
    readFile: async (name: string) => new Uint8Array(await readFile(path(name))),
    writeFile: async (name: string, bytes: Uint8Array) => { await writeFile(path(name), bytes); },
    mkdir: async (name: string) => { await mkdir(path(name), { recursive: true }); },
    remove: async (name: string) => { await rm(path(name), { recursive: true }); },
  } } as Pick<Workspace, 'fs'>;
  try {
    await writeFile(path('/source.ts'), 'saved edit');
    expect(await preparePreviewCache(workspace, 'first')).toContain('fresh');
    await writeFile(path('/.browser-editor-cache/cached'), 'optimized');
    expect(await preparePreviewCache(workspace, 'first')).toContain('Reusing');
    expect(await readFile(path('/.browser-editor-cache/cached'), 'utf8')).toBe('optimized');
    expect(await preparePreviewCache(workspace, 'second')).toContain('fresh');
    expect(await stat(path('/.browser-editor-cache/cached')).catch(() => null)).toBeNull();
    await rm(path('/.browser-editor-cache/preparation'));
    expect(await preparePreviewCache(workspace, 'second')).toContain('fresh');
    expect(await readFile(path('/source.ts'), 'utf8')).toBe('saved edit');
  } finally { await rm(root, { recursive: true, force: true }); }
});
