import { test, expect } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, chmod, symlink, readlink, stat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureTree } from '../src/prepare-tree';
import { treeInstaller, validateTree, type PreparedEntry } from '../src/package-tree';

test('captured package tree round-trips executable bins, links, modes and empty directories', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'prepared-tree-test-'));
  try {
    const source = join(temporary, 'source'), guest = join(temporary, 'guest');
    await mkdir(join(source, '.bin'), { recursive: true });
    await mkdir(join(source, 'demo', 'empty'), { recursive: true });
    await writeFile(join(source, 'demo', 'cli.cjs'), '#!/usr/bin/env bun\nconsole.log(require("./value.cjs"))\n');
    await writeFile(join(source, 'demo', 'value.cjs'), 'module.exports="relative-resolution-ok";');
    await chmod(join(source, 'demo', 'cli.cjs'), 0o751);
    await chmod(join(source, 'demo', 'empty'), 0o750);
    await symlink('../demo/cli.cjs', join(source, '.bin', 'demo'));
    const blobs = new Map<string, Uint8Array>();
    const tree = await captureTree(source, '/workspace/node_modules', async (file, bytes) => { blobs.set(file, bytes); });
    validateTree(tree);
    const map = (path: string) => join(guest, path);
    // Exercise the exact generated guest program against real Node-compatible fs,
    // mapping only its absolute guest paths into a private test directory.
    const guestFS = {
      rmSync: (path: string, options: any) => fs.rmSync(map(path), options),
      mkdirSync: (path: string, options: any) => fs.mkdirSync(map(path), options),
      symlinkSync: (target: string, path: string) => fs.symlinkSync(target, map(path)),
      chmodSync: (path: string, mode: number) => fs.chmodSync(map(path), mode),
    };
    new Function('require', treeInstaller(tree, 'reset'))(() => guestFS);
    for (const entry of tree) if (entry.kind === 'file') await writeFile(map(entry.destination), blobs.get(entry.file)!);
    new Function('require', treeInstaller(tree, 'metadata'))(() => guestFS);
    expect(await readlink(map('/workspace/node_modules/.bin/demo'))).toBe('../demo/cli.cjs');
    expect((await stat(map('/workspace/node_modules/demo/cli.cjs'))).mode & 0o777).toBe(0o751);
    expect((await stat(map('/workspace/node_modules/demo/empty'))).mode & 0o777).toBe(0o750);
    expect(await readFile(map('/workspace/node_modules/demo/value.cjs'), 'utf8')).toBe('module.exports="relative-resolution-ok";');
    const child = Bun.spawn([process.execPath, map('/workspace/node_modules/.bin/demo')], { stdout: 'pipe' });
    expect(await new Response(child.stdout).text()).toBe('relative-resolution-ok\n');
    expect(await child.exited).toBe(0);
    expect(await captureTree(map('/workspace/node_modules'), '/workspace/node_modules', async () => {})).toEqual(tree);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('tree validator rejects dangling, escaping, cyclic and write-through links', () => {
  const root: PreparedEntry = { kind: 'directory', destination: '/workspace/node_modules', mode: 0o755 };
  const link = (name: string, target: string): PreparedEntry => ({ kind: 'symlink', destination: root.destination + '/' + name, target });
  for (const entries of [
    [root, link('a', 'missing')], [root, link('a', '/etc/passwd')],
    [root, link('a', '../../outside')], [root, link('a', 'b'), link('b', 'a')],
    [root, link('a', '.'), { kind: 'directory', destination: root.destination + '/a/child', mode: 0o755 } as PreparedEntry],
    [root, { ...root }], [root, link('a', '../node_modules')],
  ]) expect(() => validateTree(entries)).toThrow();
});

test('capture rejects host dangling and escaping links without copying their targets', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'prepared-link-test-'));
  try {
    await mkdir(join(temporary, 'tree'));
    await writeFile(join(temporary, 'outside'), 'not a package');
    await symlink('../outside', join(temporary, 'tree', 'escape'));
    await expect(captureTree(join(temporary, 'tree'), '/workspace/node_modules', async () => {})).rejects.toThrow('Escaping package link');
    await rm(join(temporary, 'tree', 'escape'));
    await symlink('missing', join(temporary, 'tree', 'dangling'));
    await expect(captureTree(join(temporary, 'tree'), '/workspace/node_modules', async () => {})).rejects.toThrow();
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
