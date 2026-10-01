// Parameter-free Tailwind backend setup: reuse the retained source-built candidate,
// or build it once with build-tailwind-wasm-candidate.ts. That recipe needs the
// pinned native Node; without --node it is fetched, checksummed, into .runtime.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const pin = JSON.parse(readFileSync(join(root, '../opencode-chat/src/tailwind-wasm-candidate.json'), 'utf8'));
const args = process.argv.slice(2);
if (args.includes('--help') || (args.length && (args.length !== 2 || args[0] !== '--node'))) {
  console.log('Usage: bun scripts/setup-tailwind-candidate.ts [--node /absolute/native/node]\nReuses .runtime/tailwind-wasm-candidate/current.json when its receipt verifies; otherwise builds the pinned candidate. Rust and the WASM target named in the pin must already be installed.');
  process.exit(args.includes('--help') ? 0 : 1);
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const candidates = join(root, '.runtime/tailwind-wasm-candidate');
const pointerPath = join(candidates, 'current.json');
if (existsSync(pointerPath)) {
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
  if (pointer.id === pin.id && existsSync(join(candidates, pointer.receipt)) && sha256(readFileSync(join(candidates, pointer.receipt))) === pointer.receiptSha256) {
    console.log(`Tailwind backend candidate already present: ${join(candidates, pointer.receipt)}`);
    process.exit(0);
  }
  console.log('Retained Tailwind backend candidate does not match the pin; building it.');
}

// Official release archives, from https://nodejs.org/dist/v24.13.0/SHASUMS256.txt.
const nodeArchives: Record<string, string> = {
  'v24.13.0-darwin-arm64': 'd595961e563fcae057d4a0fb992f175a54d97fcc4a14dc2d474d92ddeea3b9f8',
  'v24.13.0-darwin-x64': '6f03c1b48ddbe1b129a6f8038be08e0899f05f17185b4d3e4350180ab669a7f3',
  'v24.13.0-linux-arm64': '0f6d40b94c6a2eb6b4c240ffc8b9fd3ada7ab044c177dd413c06e1ef9a63f081',
  'v24.13.0-linux-x64': '6223aad1a81f9d1e7b682c59d12e2de233f7b4c37475cd40d1c89c42b737ffa8',
};
async function pinnedNode() {
  const name = `${pin.node}-${process.platform}-${process.arch}`;
  const directory = join(root, '.runtime', `node-${name}`);
  const node = join(directory, 'bin/node');
  if (existsSync(node)) return node;
  const expected = nodeArchives[name];
  if (!expected) throw Error(`No pinned Node archive for ${name}; pass --node /absolute/path/to/node (${pin.node})`);
  const url = `https://nodejs.org/dist/${pin.node}/node-${name}.tar.gz`;
  console.log(`Fetching ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw Error(`Node download: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw Error('Node archive integrity failure');
  mkdirSync(join(root, '.runtime'), { recursive: true });
  const staging = mkdtempSync(join(root, '.runtime/.node-'));
  try {
    await Bun.write(join(staging, 'node.tgz'), bytes);
    const tar = Bun.spawnSync(['tar', '-xzf', join(staging, 'node.tgz'), '-C', staging], { stdout: 'inherit', stderr: 'inherit' });
    if (tar.exitCode !== 0) throw Error('Node archive extraction failed');
    renameSync(join(staging, `node-${name}`), directory);
  } finally { rmSync(staging, { recursive: true, force: true }); }
  return node;
}
const node = args[1] ? resolve(args[1]) : await pinnedNode();
const build = Bun.spawnSync(['bun', join(import.meta.dir, 'build-tailwind-wasm-candidate.ts'), '--node', node], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
if (build.exitCode !== 0) throw Error('Tailwind backend candidate build failed');
