// Build the standalone fork. Dev accepts local edits; --release requires committed source.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { integrationRoot as root, resolveRuntimeSource, runtimeConfig } from './runtime-source.mjs';
import { cacheMatches, fileManifest, fingerprint, hashFile, sha256, treeFiles } from './runtime-fingerprint.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: bun scripts/build-runtime.ts [fork|patched|baseline] [--native] [--release] [--revision <commit>]\nDefault: sibling fork (VIVARI_SOURCE override), incremental native + core build.\n--native: force all Rust/WASM build commands. --release: require clean source at runtime-source.json revision.\n--revision <commit>: verify a different committed revision (also recorded in receipt); never checks out or resets source.\nDev builds accept any HEAD and local edits. Baseline: existing .runtime/baseline or VIVARI_BASELINE_SOURCE checkout.\nFresh checkout: bun scripts/setup-runtime.ts');
  process.exit(0);
}
let requestedRevision: string | undefined;
const revisionIndex = args.indexOf('--revision');
if (revisionIndex >= 0) {
  requestedRevision = args[revisionIndex + 1];
  if (!requestedRevision || !/^[a-f0-9]{7,40}$/i.test(requestedRevision)) throw new Error('--revision requires a commit hash');
  args.splice(revisionIndex, 2);
}
if (args.some(arg => !['fork', 'patched', 'baseline', '--native', '--release'].includes(arg)) || args.filter(arg => !arg.startsWith('--')).length > 1) {
  throw new Error('Expected [fork|patched|baseline] [--native] [--release] [--revision <commit>]; see --help');
}
const mode = args.includes('baseline') ? 'baseline' : 'fork';
const receiptName = mode === 'fork' ? 'patched' : 'baseline';
const release = args.includes('--release');
const source = resolveRuntimeSource(mode);
if (!existsSync(join(source, 'packages/core/package.json'))) {
  throw new Error(`Vivari source missing at ${source}. Clone ${runtimeConfig.repository} there or set ${mode === 'baseline' ? 'VIVARI_BASELINE_SOURCE' : 'VIVARI_SOURCE'}.`);
}
const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}`, RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN || runtimeConfig.rustToolchain };
function command(args: string[], capture = false, optional = false) {
  if (!capture) console.log('$', args.join(' '));
  const result = Bun.spawnSync(args, { cwd: source, env, stdout: capture ? 'pipe' : 'inherit', stderr: capture ? 'pipe' : 'inherit' });
  if (result.exitCode !== 0) {
    if (optional) return null;
    throw new Error(`Failed (${result.exitCode}): ${args.join(' ')}${capture ? `\n${result.stderr}` : ''}`);
  }
  return capture ? result.stdout!.toString().trim() : '';
}
const git = (...args: string[]) => command(['git', ...args], true)!;
const revision = git('rev-parse', 'HEAD');
const status = () => git('status', '--porcelain=v1', '--untracked-files=all');
const initialStatus = status();
if (release && initialStatus) throw new Error(`--release requires clean committed Vivari source (including lockfiles):\n${initialStatus}`);
const expectedRevision = requestedRevision || (release ? mode === 'fork' ? runtimeConfig.revision : runtimeConfig.upstreamBase : undefined);
if (expectedRevision && revision !== git('rev-parse', `${expectedRevision}^{commit}`)) {
  throw new Error(`Expected source revision ${expectedRevision}, got ${revision}. Update runtime-source.json or pass --revision <commit> explicitly.`);
}
const listSource = () => git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean);
const sourceManifest = fileManifest(source, listSource());
const sourceFingerprint = fingerprint(sourceManifest);
const toolchain = {
  bun: Bun.version, rustToolchain: env.RUSTUP_TOOLCHAIN, rustc: command(['rustc', '-vV'], true),
  cargo: command(['cargo', '-V'], true), wasmPack: runtimeConfig.wasmPack,
  platform: process.platform, arch: process.arch,
};
const stateDir = join(root, '.runtime');
mkdirSync(stateDir, { recursive: true });
function save(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  renameSync(temporary, path);
}
command(['bun', 'install', '--frozen-lockfile']);
const nativeCrates = ['vfs', 'codec', 'crypto', 'wasi-demo'];
const excluded = new Set(['target', 'pkg', 'pkg-node', '.git', 'node_modules']);
const nativeFiles = nativeCrates.flatMap(crate => treeFiles(source, `packages/${crate}`, excluded));
nativeFiles.push(...treeFiles(source, '.cargo'));
for (const name of ['Cargo.toml', 'Cargo.lock', 'rust-toolchain', 'rust-toolchain.toml']) if (existsSync(join(source, name))) nativeFiles.push(name);
const nativeInputs = {
  schema: 1, source, toolchain,
  cargoConfig: fileManifest(process.env.CARGO_HOME || join(process.env.HOME!, '.cargo'), ['config', 'config.toml']),
  environment: Object.fromEntries(Object.entries(env).filter(([key]) => /^(CARGO_|RUST|CC|CXX|AR|CFLAGS|CXXFLAGS|LDFLAGS|WASM)/.test(key)).sort()),
  recipe: hashFile(import.meta.path), files: fileManifest(source, nativeFiles),
};
function nativeOutputs() {
  const paths = nativeCrates.flatMap(crate => treeFiles(source, `packages/${crate}/pkg`));
  for (const crate of ['vfs', 'codec', 'crypto']) {
    paths.push(...treeFiles(source, `packages/${crate}/pkg-node`));
    for (const dir of ['pkg', 'pkg-node']) paths.push(`packages/${crate}/${dir}/vivari_${crate}.js`, `packages/${crate}/${dir}/vivari_${crate}_bg.wasm`);
  }
  paths.push('packages/wasi-demo/pkg/wasi_demo.wasm');
  return fileManifest(source, paths);
}
const cachePath = join(stateDir, `${receiptName}-native-build.json`);
let previous;
try { previous = JSON.parse(readFileSync(cachePath, 'utf8')); } catch {}
const nativeRebuilt = args.includes('--native') || !cacheMatches(previous, nativeInputs, nativeOutputs());
if (nativeRebuilt) {
  for (const crate of ['vfs', 'codec', 'crypto']) {
    for (const target of ['web', 'nodejs']) {
      command(['bunx', '--package', `wasm-pack@${runtimeConfig.wasmPack}`, 'wasm-pack', 'build', `packages/${crate}`,
        '--target', target, '--out-dir', target === 'web' ? 'pkg' : 'pkg-node', '--locked']);
    }
  }
  command(['cargo', 'build', '--locked', '--release', '--manifest-path', 'packages/wasi-demo/Cargo.toml', '--target', 'wasm32-wasip1']);
  mkdirSync(join(source, 'packages/wasi-demo/pkg'), { recursive: true });
  copyFileSync(join(source, 'packages/wasi-demo/target/wasm32-wasip1/release/wasi_demo.wasm'), join(source, 'packages/wasi-demo/pkg/wasi_demo.wasm'));
} else console.log('Native Rust/WASM inputs, toolchain and outputs unchanged; skipping (use --native to force).');
const outputs = nativeOutputs();
if (outputs.some(file => !file.sha256)) throw new Error('Native build left missing output files');
save(cachePath, { fingerprint: fingerprint(nativeInputs), inputs: nativeInputs, outputs });

const dist = join(source, 'packages/core/dist');
// Live kernels retain hashed worker URLs across rebuilds. Preserve them in dev;
// release assets must all come from this build, not an older local revision.
const retained = join(stateDir, `${receiptName}-retained-assets`);
if (!release) {
  mkdirSync(retained, { recursive: true });
  if (existsSync(join(dist, 'assets'))) cpSync(join(dist, 'assets'), retained, { recursive: true });
}
command(['bun', 'run', '--cwd', 'packages/core', 'build']);
const currentAssets = new Set(treeFiles(dist));
if (!release) for (const name of treeFiles(retained)) {
  const destination = join(dist, 'assets', name);
  if (!existsSync(destination)) {
    mkdirSync(resolve(destination, '..'), { recursive: true });
    copyFileSync(join(retained, name), destination);
  }
}
mkdirSync(join(dist, 'assets'), { recursive: true });
copyFileSync(join(source, 'LICENSE'), join(dist, 'assets/LICENSE.vivari.txt'));
if (mode === 'fork') copyFileSync(join(root, 'LICENSE.sqlite-wasm'), join(dist, 'assets/LICENSE.sqlite-wasm.txt'));
if (git('rev-parse', 'HEAD') !== revision || fingerprint(fileManifest(source, listSource())) !== sourceFingerprint) {
  throw new Error('Vivari source changed during build; rerun to produce a consistent receipt.');
}
if (release && status()) throw new Error('--release source became dirty during build');
save(join(stateDir, `${receiptName}-build.json`), {
  schema: 2, revision, expectedRevision: expectedRevision ?? null, license: 'MIT', mode, release, builtAt: new Date().toISOString(),
  source: { path: source, repository: runtimeConfig.repository, origin: command(['git', 'remote', 'get-url', 'origin'], true, true),
    commit: revision, dirty: !!initialStatus, status: initialStatus, fingerprint: sourceFingerprint,
    diffSha256: sha256(git('diff', '--binary', 'HEAD')), files: sourceManifest },
  upstream: { repository: runtimeConfig.upstream, baseRevision: runtimeConfig.upstreamBase,
    remote: command(['git', 'remote', 'get-url', 'upstream'], true, true) },
  toolchain, bun: Bun.version, rust: env.RUSTUP_TOOLCHAIN, wasmPack: runtimeConfig.wasmPack,
  sqlite: mode === 'fork' ? { package: '@sqlite.org/sqlite-wasm', version: '3.49.1-build1', engine: '3.49.1', license: 'Apache-2.0 (package); public domain (SQLite)' } : null,
  npmLockSha256: existsSync(join(source, 'package-lock.json')) ? hashFile(join(source, 'package-lock.json')) : null,
  locks: sourceManifest.filter(file => /(^|\/)(bun.lockb?|package-lock.json|Cargo.lock|pnpm-lock.yaml|yarn.lock)$/.test(file.name)),
  patches: [], native: { rebuilt: nativeRebuilt, fingerprint: fingerprint(nativeInputs), outputs },
  assets: fileManifest(dist, treeFiles(dist)).map(file => ({ ...file, retained: !currentAssets.has(file.name) && !file.name.startsWith('assets/LICENSE.') })),
});
console.log(`Built ${dist}`);
