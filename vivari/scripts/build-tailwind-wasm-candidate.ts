// Build and qualify the user's exact upstream PR; never edit upstream package sources.
// Output is a separately identified backend candidate, not registry oxide@4.3.3.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dir, '..');
const pinPath = join(root, '../opencode-chat/src/tailwind-wasm-candidate.json');
const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: bun scripts/build-tailwind-wasm-candidate.ts --node /absolute/native/node [--source /existing/tailwind/git-checkout] [--temp-root /approved/temp]\nBuilds the immutable PR pin in an isolated clone, twice; packs upstream files and bundled dependencies unchanged; requires same-instance native parity. Retains .runtime/tailwind-wasm-candidate/<revision>/<package-manifest-hash>/receipt.json and an atomic current.json pointer. --source reads committed Git objects only and never edits that checkout. The native Node version must match the pin. Rust and the WASM target must already be installed.');
  process.exit(0);
}
function option(name: string) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  args.splice(i, 2);
  return resolve(value);
}
const node = option('--node');
const localSource = option('--source');
const tempRoot = option('--temp-root') ?? join(tmpdir(), 'opencode');
if (!node || args.length) throw new Error('Expected --node and optional --source / --temp-root; see --help');
mkdirSync(tempRoot, { recursive: true });
const work = mkdtempSync(join(realpathSync(tempRoot), 'tailwind-wasm-candidate-'));
const source = join(work, 'source');
const evidence = join(work, 'evidence');
mkdirSync(evidence);
console.log(`Isolated build: ${work}`);
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hashFile = (path: string) => hash(readFileSync(path));
const recipeSha256 = hashFile(import.meta.path);
const pinSha256 = hashFile(pinPath);
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const env = { ...process.env, PATH: `${dirname(node)}:${process.env.PATH}`, RUSTUP_TOOLCHAIN: pin.rust, CARGO_INCREMENTAL: '0', NODE_PATH: '', NODE_OPTIONS: '' };
// Build flags come from the pinned upstream .cargo/config.toml, not caller overrides.
for (const key of ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_BUILD_TARGET', 'CARGO_TARGET_DIR', 'NAPI_RS_NATIVE_LIBRARY_PATH', 'EMNAPI_LINK_DIR']) delete (env as Record<string, string | undefined>)[key];
const commands: { argv: string[]; cwd: string; log: string; exitCode: number }[] = [];
function run(argv: string[], cwd = work, extraEnv: Record<string, string> = {}) {
  const result = Bun.spawnSync(argv, { cwd, env: { ...env, ...extraEnv }, stdout: 'pipe', stderr: 'pipe' });
  const log = `command-${String(commands.length + 1).padStart(2, '0')}.log`;
  writeFileSync(join(evidence, log), Buffer.concat([result.stdout, result.stderr]));
  commands.push({ argv, cwd, log, exitCode: result.exitCode });
  save(join(evidence, 'commands.json'), commands);
  if (result.exitCode !== 0) throw new Error(`Failed (${result.exitCode}): ${argv.join(' ')}\n${result.stderr}\nEvidence: ${join(evidence, log)}`);
  return result.stdout.toString().trim();
}
function manifest(dir: string, prefix = ''): { path: string; bytes: number; sha256: string }[] {
  return readdirSync(join(dir, prefix)).sort().flatMap(name => {
    const path = prefix ? `${prefix}/${name}` : name;
    const full = join(dir, path);
    const stat = lstatSync(full);
    if (stat.isDirectory()) return manifest(dir, path);
    assert(stat.isFile(), `Only ordinary files may be delivered: ${full}`);
    return [{ path, bytes: stat.size, sha256: hashFile(full) }];
  });
}
function sections(bytes: Uint8Array) {
  assert.deepEqual([...bytes.subarray(0, 8)], [0, 97, 115, 109, 1, 0, 0, 0]);
  function leb(start: number): [number, number] {
    let value = 0, shift = 0, i = start;
    for (;;) {
      assert(i < bytes.length && shift < 35, 'Malformed WASM section');
      const byte = bytes[i++]!;
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return [value, i];
      shift += 7;
    }
  }
  const records = [];
  for (let i = 8; i < bytes.length;) {
    const id = bytes[i]!;
    const [size, start] = leb(i + 1);
    assert(start + size <= bytes.length);
    let name = '';
    if (id === 0) {
      const [length, offset] = leb(start);
      name = new TextDecoder().decode(bytes.subarray(offset, offset + length));
    }
    records.push({ id, name, bytes: size, sha256: hash(bytes.subarray(start, start + size)) });
    i = start + size;
  }
  return records;
}

const nodeInfo = JSON.parse(run([node, '-p', 'JSON.stringify({version:process.version,release:process.release.name,platform:process.platform,arch:process.arch,versions:process.versions})']));
assert.equal(nodeInfo.release, 'node', '--node must be native Node, not Bun');
assert.equal(nodeInfo.version, pin.node);
// Cloning an existing checkout uses committed objects, preserving all user modifications.
run(['git', 'clone', '--no-checkout', localSource ?? pin.repository, source]);
run(['git', 'checkout', '--detach', pin.revision], source);
assert.equal(run(['git', 'rev-parse', 'HEAD'], source), pin.revision);
assert.equal(run(['git', 'rev-parse', 'HEAD^{tree}'], source), pin.tree);
assert.equal(run(['git', 'status', '--porcelain', '--untracked-files=all'], source), '');
assert.deepEqual(run(['git', 'diff', '--name-only', pin.upstreamBase, 'HEAD'], source).split('\n').sort(), [...pin.changedFiles].sort());
writeFileSync(join(evidence, 'upstream-pr.patch'), run(['git', 'diff', '--binary', pin.upstreamBase, 'HEAD'], source) + '\n');
run(['git', 'archive', '--format=tar', `--output=${join(evidence, 'source.tar')}`, 'HEAD'], source);
const sourceInputs = ['Cargo.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'rust-toolchain.toml', 'crates/node/.cargo/config.toml', 'crates/node/package.json', 'crates/node/npm/wasm32-wasi/package.json'];
const inputs = sourceInputs.map(path => ({ path, sha256: hashFile(join(source, path)) }));
assert.equal(JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).packageManager, `pnpm@${pin.pnpm.version}`);
const rustToolchain = Bun.TOML.parse(readFileSync(join(source, 'rust-toolchain.toml'), 'utf8')) as { toolchain: { channel: string } };
assert.equal(rustToolchain.toolchain.channel, pin.rust);
const rustc = run(['rustc', '-vV'], source);
const cargo = run(['cargo', '-V'], source);
assert(run(['rustup', 'target', 'list', '--installed'], source).split('\n').includes(pin.target), `Install Rust ${pin.rust} target ${pin.target} before building`);
copyFileSync(pinPath, join(evidence, 'pin.json'));
copyFileSync(import.meta.path, join(evidence, 'build-tailwind-wasm-candidate.ts'));
copyFileSync(join(source, 'crates/node/npm/wasm32-wasi/package.json'), join(evidence, 'original-package.json'));
copyFileSync(join(source, 'pnpm-lock.yaml'), join(evidence, 'pnpm-lock.yaml'));
copyFileSync(join(source, 'Cargo.lock'), join(evidence, 'Cargo.lock'));

console.log(`Building ${pin.id} with upstream frozen locks`);
const pnpmArchive = join(evidence, 'pnpm.tgz');
const response = await fetch(pin.pnpm.tarball);
assert(response.ok, `pnpm download: ${response.status}`);
const pnpmBytes = new Uint8Array(await response.arrayBuffer());
assert.equal(hash(pnpmBytes), pin.pnpm.sha256, 'Pinned pnpm tarball hash mismatch');
writeFileSync(pnpmArchive, pnpmBytes);
const tools = join(work, 'tools');
mkdirSync(tools);
run(['tar', '-xzf', pnpmArchive, '-C', tools]);
const pnpm = join(tools, 'package/bin/pnpm.cjs');
assert.equal(run([node, pnpm, '--version']), pin.pnpm.version);
run([node, pnpm, '--filter', '@tailwindcss/oxide...', 'install', '--frozen-lockfile', '--ignore-scripts'], source);
const crate = join(source, 'crates/node');
const napi = join(crate, 'node_modules/@napi-rs/cli/dist/cli.js');
const buildTools = Object.fromEntries(['@napi-rs/cli', '@napi-rs/wasm-runtime', 'emnapi', '@emnapi/core', '@emnapi/runtime'].map(name => {
  const file = join(crate, 'node_modules', name, 'package.json');
  return [name, { version: JSON.parse(readFileSync(file, 'utf8')).version, metadataSha256: hashFile(file) }];
}));
const buildEnvironment = Object.fromEntries(Object.entries(env).filter(([key]) => /^(CARGO_|RUST|CC$|CXX$|AR$|CFLAGS|CXXFLAGS|LDFLAGS|WASM|NAPI_|EMNAPI_)/.test(key)));
const cargoHome = process.env.CARGO_HOME ?? join(process.env.HOME!, '.cargo');
const hostCargoConfig = ['config', 'config.toml'].filter(name => existsSync(join(cargoHome, name))).map(name => {
  copyFileSync(join(cargoHome, name), join(evidence, `host-cargo-${name}`));
  return { name, sha256: hashFile(join(cargoHome, name)) };
});
const buildWasm = (target: string) => run([node, napi, 'build', '--release', '--target', pin.target, '--', '--locked'], crate, { CARGO_TARGET_DIR: target });
buildWasm(join(work, 'target-first'));
const firstWasm = readFileSync(join(crate, 'tailwindcss-oxide.wasm'));
writeFileSync(join(evidence, 'first-build.wasm'), firstWasm);
buildWasm(join(work, 'target-second'));
const secondWasm = readFileSync(join(crate, 'tailwindcss-oxide.wasm'));
const firstSections = sections(firstWasm), secondSections = sections(secondWasm);
assert.deepEqual(firstSections.filter(s => s.name !== 'build_id'), secondSections.filter(s => s.name !== 'build_id'), 'Clean builds differ beyond WASM build_id');
const reproducibility = { byteIdentical: hash(firstWasm) === hash(secondWasm), identicalExceptBuildId: true, firstSha256: hash(firstWasm), secondSha256: hash(secondWasm), firstSections, secondSections };
save(join(evidence, 'reproducibility.json'), reproducibility);
// Same-source native build is the parity control, loaded directly as a .node addon.
run([node, napi, 'build', '--platform', '--release', '--', '--locked'], crate, { CARGO_TARGET_DIR: join(work, 'target-native') });
const nativeFiles = readdirSync(crate).filter(name => name.endsWith('.node'));
assert.equal(nativeFiles.length, 1, 'Expected one fresh native control');
const native = join(crate, nativeFiles[0]!);
copyFileSync(native, join(evidence, nativeFiles[0]!));
run([node, join(crate, 'scripts/move-artifacts.mjs')], crate);
const wasmPackage = join(crate, 'npm/wasm32-wasi');
const packed = join(work, 'packed');
mkdirSync(packed);
// This is the exact upstream pack configuration for bundledDependencies.
run([node, pnpm, 'pack', '--pack-gzip-level=0', '--pack-destination', packed, '--config.node-linker=hoisted'], wasmPackage);
const archives = readdirSync(packed).filter(name => name.endsWith('.tgz'));
assert.equal(archives.length, 1);
const archive = join(packed, archives[0]!);
const unpacked = join(work, 'unpacked');
mkdirSync(unpacked);
run(['tar', '-xzf', archive, '-C', unpacked]);
const packageRoot = join(unpacked, 'package');
const originalMetadata = JSON.parse(readFileSync(join(evidence, 'original-package.json'), 'utf8'));
const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
assert.deepEqual(metadata, originalMetadata, 'Upstream pack changed package metadata semantics');
assert.equal(metadata.name, pin.packageName);
assert.equal(metadata.version, pin.packageVersion);
assert.equal(hashFile(join(packageRoot, 'tailwindcss-oxide.wasm32-wasi.wasm')), hash(secondWasm));
for (const name of metadata.files) assert.equal(hashFile(join(packageRoot, name)), hashFile(join(wasmPackage, name)), `Pack changed generated file ${name}`);
const dependencies = Object.entries(metadata.dependencies).map(([name, range]) => {
  const path = `node_modules/${name}/package.json`;
  const dep = JSON.parse(readFileSync(join(packageRoot, path), 'utf8'));
  return { name, range, version: dep.version, metadataPath: path, metadataSha256: hashFile(join(packageRoot, path)) };
});
assert.deepEqual([...metadata.bundledDependencies].sort(), dependencies.map(d => d.name).sort());

const probe = String.raw`
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const [entry, output] = process.argv.slice(2);
const { Scanner } = require(entry);
const root = fs.mkdtempSync(path.join(path.dirname(output), 'fixture-'));
const a = path.join(root, 'index.html'), b = path.join(root, 'added.html');
let time = Date.now();
const records = [];
try {
  const write = (file, classes) => { fs.writeFileSync(file, '<div class="' + classes + '"></div>'); time += 2000; fs.utimesSync(file, time / 1000, time / 1000); };
  write(a, 'flex');
  const scanner = new Scanner({ sources: [{ base: root, pattern: '**/*', negated: false }] });
  const scan = (step, wanted, expectedFiles, expectedChanged) => {
    const candidates = scanner.scan();
    const files = scanner.files.map(p => path.relative(root, p)).sort();
    const scannedFiles = scanner.scannedFiles.map(p => path.relative(root, p)).sort();
    records.push({ step, candidates, files, scannedFiles });
    for (const candidate of wanted) assert(candidates.includes(candidate), step + ': missing ' + candidate);
    assert.deepEqual(files, expectedFiles, step + ': files');
    assert.deepEqual(scannedFiles, expectedChanged, step + ': scannedFiles');
  };
  scan('initial', ['flex'], ['index.html'], ['index.html']);
  scan('unchanged', ['flex'], ['index.html'], []);
  write(a, 'flex text-[37px]'); scan('edit-1', ['text-[37px]'], ['index.html'], ['index.html']);
  write(a, 'flex text-[41px]'); scan('edit-2', ['text-[41px]'], ['index.html'], ['index.html']);
  write(b, 'grid p-[19px]'); scan('add', ['grid', 'p-[19px]'], ['added.html', 'index.html'], ['added.html']);
  fs.unlinkSync(b); scan('remove', ['text-[41px]'], ['index.html'], []);
  write(a, 'flex text-[43px]'); scan('edit-after-remove', ['text-[43px]'], ['index.html'], ['index.html']);
  scan('unchanged-final', ['text-[43px]'], ['index.html'], []);
  fs.writeFileSync(output, JSON.stringify({ entry, node: process.version, records, pass: true }, null, 2) + '\n');
  console.log('TAILWIND_SCANNER_SAME_INSTANCE_PASS');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
`;
writeFileSync(join(evidence, 'probe.cjs'), probe);
for (const [label, entry] of [['wasm', packageRoot], ['native', native]]) {
  const output = run([node, join(evidence, 'probe.cjs'), entry!, join(evidence, `${label}.json`)]);
  assert(output.includes('TAILWIND_SCANNER_SAME_INSTANCE_PASS'), `Missing ${label} completion checkpoint`);
}
const wasmRecords = JSON.parse(readFileSync(join(evidence, 'wasm.json'), 'utf8')).records;
assert.deepEqual(wasmRecords, JSON.parse(readFileSync(join(evidence, 'native.json'), 'utf8')).records, 'WASM/native record parity');
assert.equal(run(['git', 'status', '--porcelain', '--untracked-files=all'], source), '', 'Build changed tracked source or introduced unignored source files');
assert.deepEqual(inputs, sourceInputs.map(path => ({ path, sha256: hashFile(join(source, path)) })), 'Build input drift');
assert.equal(hashFile(import.meta.path), recipeSha256, 'Build recipe changed during execution');
assert.equal(hashFile(pinPath), pinSha256, 'Candidate pin changed during execution');
const files = manifest(packageRoot);
const packageManifestSha256 = hash(JSON.stringify(files));
const outputRoot = join(root, '.runtime/tailwind-wasm-candidate');
const artifactDirectory = `${pin.revision}/${packageManifestSha256}`;
const destination = join(outputRoot, artifactDirectory);
mkdirSync(dirname(destination), { recursive: true });
const staging = mkdtempSync(join(dirname(destination), '.candidate-'));
cpSync(packageRoot, join(staging, 'package'), { recursive: true });
copyFileSync(archive, join(staging, 'package.tgz'));
cpSync(evidence, join(staging, 'evidence'), { recursive: true });
const receipt = {
  schema: 1, kind: 'tailwind-wasm-source-candidate', id: pin.id, builtAt: new Date().toISOString(),
  source: { repository: pin.repository, revision: pin.revision, tree: pin.tree, upstreamBase: pin.upstreamBase, pullRequest: pin.pullRequest, dirty: false, inputs, archiveSha256: hashFile(join(evidence, 'source.tar')), patchSha256: hashFile(join(evidence, 'upstream-pr.patch')) },
  recipe: { pinSha256, scriptSha256: recipeSha256, commands: 'evidence/commands.json' },
  toolchain: { node: nodeInfo, nodeExecutableSha256: hashFile(node), bun: Bun.version, rustc, cargo, target: pin.target, pnpm: pin.pnpm, buildTools, environment: buildEnvironment, hostCargoConfig },
  package: { name: metadata.name, version: metadata.version, path: 'package', registryArtifact: false, metadata, originalMetadataPath: 'evidence/original-package.json', originalMetadataSha256: hashFile(join(evidence, 'original-package.json')), metadataSha256: hashFile(join(packageRoot, 'package.json')), dependencies, files, manifestSha256: packageManifestSha256, tarball: 'package.tgz', tarballSha256: hashFile(archive), wasmSha256: hash(secondWasm) },
  verification: { sameInstanceNativeParity: true, checkpoints: wasmRecords.length, wasmReceipt: 'evidence/wasm.json', nativeReceipt: 'evidence/native.json', nativeControl: { sourceRevision: pin.revision, binary: `evidence/${nativeFiles[0]}`, sha256: hashFile(native) }, reproducibility, browserHmrAccepted: false },
  evidence: manifest(join(staging, 'evidence')),
};
save(join(staging, 'receipt.json'), receipt);
// Immutable package directories retain older running consumers' exact bytes.
if (existsSync(destination)) {
  assert.deepEqual(manifest(join(destination, 'package')), files, 'Existing content-addressed package was modified');
  throw new Error(`Artifact already exists at ${destination}; new receipt retained at ${staging}. Existing receipt was not overwritten.`);
}
renameSync(staging, destination);
const pointer = { schema: 1, id: pin.id, artifactDirectory, receipt: `${artifactDirectory}/receipt.json`, receiptSha256: hashFile(join(destination, 'receipt.json')) };
const currentTemporary = join(outputRoot, `current.${process.pid}.json`);
save(currentTemporary, pointer);
renameSync(currentTemporary, join(outputRoot, 'current.json'));
console.log(JSON.stringify({ checkpoint: 'TAILWIND_WASM_CANDIDATE_READY', ...pointer, packageRoot: join(destination, 'package'), sameInstanceNativeParity: true, browserHmrAccepted: false }, null, 2));
