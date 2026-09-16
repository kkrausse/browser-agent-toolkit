import type { ToolDescriptor, NodeLaunchOptions } from '@kev-browser-agent-kit/workspace';
import { treeInstaller, treeRoots, validateTree, type PreparedEntry } from './package-tree';
import type { DependencyProvenance } from './prepare-dependencies';
import { openCodeCandidateLaunch } from './opencode-launch';
import { readPreparedBundle, type PreparedBundle } from './prepared-bundle';

export interface PreparedOpenCode {
  id: string; format: typeof openCodeCandidateLaunch.format; receiptSha256: string; sourceRevision: string; receipt: string;
  support: { name: 'ripgrep'; version: '0.3.1'; integrity: string; linker: 'isolated'; manifest: string; manifestSha256: string; lock: string; lockSha256: string; binDirectory: string };
}

async function sha256(bytes: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Bind browser delivery to the exact retained receipt, not a manifest's self-declared pin. */
export async function validatePreparedOpenCode(manifest: Pick<PreparedManifest, 'opencode' | 'assets'>) {
  const candidate = manifest.opencode, expected = openCodeCandidateLaunch;
  if (!candidate || candidate.format !== expected.format || candidate.id !== expected.candidate
    || candidate.sourceRevision !== expected.sourceRevision || candidate.receiptSha256 !== expected.receiptSha256
    || typeof candidate.receipt !== 'string' || await sha256(new TextEncoder().encode(candidate.receipt)) !== expected.receiptSha256) throw Error('Prepared OpenCode candidate receipt mismatch');
  const receipt = JSON.parse(candidate.receipt);
  const outputs = Object.entries(receipt.outputs) as [string, { bytes: number; sha256: string }][];
  if (outputs.length !== 5) throw Error('Prepared OpenCode output count mismatch');
  for (const [file, output] of outputs) {
    const asset = manifest.assets.find(entry => entry.destination === '/app/' + file);
    if (asset?.kind !== 'file' || asset.bytes !== output.bytes || asset.sha256 !== output.sha256) throw Error(`Prepared OpenCode output mismatch: ${file}`);
  }
  if (manifest.assets.some(entry => entry.destination.startsWith('/opencode-v2/'))) throw Error('Legacy OpenCode delivery is unsupported');
  const support = candidate.support;
  if (!support || support.name !== 'ripgrep' || support.version !== '0.3.1' || support.linker !== 'isolated'
    || support.binDirectory !== '/app/node_modules/.bin'
    || support.integrity !== 'sha512-6bDtNIBh1qPviVIU685/4uv0Ap5t8eS4wiJhy/tR2LdIeIey9CVasENlGS+ul3HnTmGANIp7AjnfsztsRmALfQ=='
    || await sha256(new TextEncoder().encode(support.manifest)) !== support.manifestSha256
    || await sha256(new TextEncoder().encode(support.lock)) !== support.lockSha256) throw Error('Prepared ripgrep provenance mismatch');
  const rg = manifest.assets.find(entry => entry.destination === support.binDirectory + '/rg');
  if (rg?.kind !== 'symlink') throw Error('Prepared ripgrep executable link missing');
}

export interface PreparedManifest {
  format: 'browser-editor-v2';
  runtimeVersion: string;
  assets: PreparedEntry[];
  bundle?: PreparedBundle;
  dependencies: DependencyProvenance;
  opencode: PreparedOpenCode;
  preview: NodeLaunchOptions;
  project: Record<string, string>;
}

/** Derived locks reference these binary inputs relative to the project root. */
export function validatePreparedBackendArchives(manifest: Pick<PreparedManifest, 'dependencies' | 'assets'>) {
  for (const archive of manifest.dependencies.backendArchives ?? []) {
    if (archive.path !== `.browser-editor-backends/${archive.sha256}.tgz`) throw Error('Invalid prepared backend archive path');
    const asset = manifest.assets.find(entry => entry.destination === '/workspace/' + archive.path);
    if (asset?.kind !== 'file' || asset.sha256 !== archive.sha256 || asset.bytes !== archive.bytes) throw Error('Prepared backend archive input missing or mismatched');
  }
}

export async function loadPrepared(base: string, signal: AbortSignal): Promise<PreparedManifest> {
  const response = await fetch(base + 'manifest.json', { signal });
  if (!response.ok) throw Error(`Editor preparation unavailable: HTTP ${response.status}`);
  const manifest = await response.json() as PreparedManifest;
  if (manifest.format !== 'browser-editor-v2') throw Error('Unsupported editor preparation; regenerate with the current preparer');
  validateTree(manifest.assets);
  validatePreparedBackendArchives(manifest);
  await validatePreparedOpenCode(manifest);
  if (manifest.dependencies.policy.runtimeVersion !== manifest.runtimeVersion) throw Error('Prepared backend policy runtime mismatch');
  for (const path of Object.keys(manifest.project)) if (!path.startsWith('/') || path.split('/').slice(1).some(part => !part || part === '.' || part === '..' || /[\\\0]/.test(part)) || path === '/node_modules' || path.startsWith('/node_modules/')) throw Error('Invalid prepared source path');
  return manifest;
}

export function preparedApps(manifest: PreparedManifest, base: string, signal: AbortSignal, report: (text: string) => void): ToolDescriptor<void, void> {
  return { name: 'browser-editor-apps', version: manifest.runtimeVersion, async bind(context) {
    return async () => {
      validateTree(manifest.assets);
      validatePreparedBackendArchives(manifest);
      async function metadata(phase: 'reset' | 'metadata') {
        const script = new TextEncoder().encode(treeInstaller(manifest.assets, phase));
        const identity = [...new Uint8Array(await crypto.subtle.digest('SHA-256', script))].map(byte => byte.toString(16).padStart(2, '0')).join('');
        const entry = `/tmp/browser-editor-tree-${phase}-${identity}.cjs`;
        await context.installFile(entry, script);
        const child = await context.node({ entry, signal });
        let output = '';
        const consume = async (stream: AsyncIterable<Uint8Array>) => {
          for await (const bytes of stream) output = (output + new TextDecoder().decode(bytes)).slice(-16000);
        };
        const readers = Promise.all([consume(child.stdout), consume(child.stderr)]);
        const result = await child.exited;
        await readers;
        if (result.exitCode !== 0 || result.signal || result.forced || !output.includes(`prepared-tree-${phase}-complete`)) throw Error(`Prepared tree ${phase} failed: ${output}`);
      }
      report(manifest.bundle ? 'Checking prepared workspace bundle cache…' : 'Downloading prepared workspace files…');
      const bundled = manifest.bundle ? await readPreparedBundle(manifest.bundle, manifest.assets, base, signal, report) : undefined;
      signal.throwIfAborted();
      if (bundled) {
        report('Loading prepared workspace into filesystem…');
        for (const asset of manifest.assets) if (asset.kind === 'file' && bundled.get(asset.file)?.byteLength !== asset.bytes) throw Error(`Asset size failure: ${asset.destination}`);
        const result = await context.installTree({
          roots: treeRoots,
          entries: manifest.assets.map(asset => asset.kind === 'file'
            ? { kind: 'file', path: asset.destination, mode: asset.mode, bytes: bundled.get(asset.file)!, sha256: asset.sha256, verifyReadback: asset.destination.startsWith('/app/') }
            : asset.kind === 'directory'
              ? { kind: 'directory', path: asset.destination, mode: asset.mode }
              : { kind: 'symlink', path: asset.destination, target: asset.target }),
        });
        signal.throwIfAborted();
        await context.installFile('/runtime-probe/.browser-editor', new TextEncoder().encode(openCodeCandidateLaunch.candidate));
        report(`Loaded ${result.files} verified files in one filesystem operation (verify ${Math.round(result.verifyMs)}ms, install ${Math.round(result.installMs)}ms, readback ${Math.round(result.readbackMs)}ms)`);
        return;
      }
      await metadata('reset');
      // Provision only a marker, never reset the entrypoint's fixed database directory.
      await context.installFile('/runtime-probe/.browser-editor', new TextEncoder().encode(openCodeCandidateLaunch.candidate));
      let done = 0;
      const files = manifest.assets.filter(asset => asset.kind === 'file');
      let next = 0;
      async function install() {
        try {
          while (next < files.length) {
            const asset = files[next++]!;
            signal.throwIfAborted();
            const response = await fetch(base + asset.file, { signal });
            if (!response.ok) throw Error(`Prepared asset HTTP ${response.status}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
            if (bytes.length !== asset.bytes || hash !== asset.sha256) throw Error(`Asset integrity failure: ${asset.destination}`);
            await context.installFile(asset.destination, bytes);
            if (asset.destination.startsWith('/app/')) {
              const installed = await context.readFile(asset.destination);
              if (installed.length !== asset.bytes || await sha256(installed) !== asset.sha256) throw Error(`Installed OpenCode integrity failure: ${asset.destination}`);
            }
            if (++done % 250 === 0) report(`Installed ${done}/${files.length} verified files`);
          }
        } catch (error) { next = files.length; throw error; }
      }
      // Bound worker messages and hashing memory; drain all work before surfacing errors.
      const results = await Promise.allSettled(Array.from({ length: Math.min(8, files.length) }, install));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      await metadata('metadata');
    };
  } };
}
