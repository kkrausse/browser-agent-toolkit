import { expect, test } from 'bun:test';
import { validatePreparedBackendArchives, type PreparedManifest } from '../src/prepared';
import { treeInstaller, validateTree, type PreparedEntry } from '../src/package-tree';

test('derived-lock archive inputs are retained as confined binary tree files', () => {
  const hash = 'a'.repeat(64), path = `.browser-editor-backends/${hash}.tgz`;
  const assets: PreparedEntry[] = [
    { kind: 'directory', destination: '/workspace/.browser-editor-backends', mode: 0o755 },
    { kind: 'file', destination: '/workspace/' + path, mode: 0o644, sha256: hash, bytes: 5, file: hash + '.bin' },
  ];
  const dependencies = { backendArchives: [{ path, sha256: hash, bytes: 5 }] } as PreparedManifest['dependencies'];
  expect(() => validateTree(assets)).not.toThrow();
  expect(() => validatePreparedBackendArchives({ dependencies, assets })).not.toThrow();
  expect(treeInstaller(assets, 'reset')).toContain('/workspace/.browser-editor-backends');
  expect(() => validatePreparedBackendArchives({ dependencies, assets: assets.slice(0, 1) })).toThrow('missing or mismatched');
  expect(() => validatePreparedBackendArchives({ dependencies, assets: [assets[0]!, { ...assets[1]!, kind: 'file', sha256: hash, bytes: 6, file: hash + '.bin', mode: 0o644 }] })).toThrow('missing or mismatched');
  expect(() => validateTree([{ kind: 'directory', destination: '/workspace/.browser-editor-backends/../source', mode: 0o755 }])).toThrow('Invalid prepared path');
});
