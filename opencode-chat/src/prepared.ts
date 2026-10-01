import type { ToolDescriptor, NodeLaunchOptions } from '@kev-browser-agent-kit/workspace';
import { treeRoots, validateTree, type PreparedEntry } from './package-tree';
import type { DependencyProvenance } from './prepare-dependencies';
import { openCodeCandidateLaunch, type OpenCodeCandidateModel } from './opencode-launch';
import type { ProjectFile } from './project-file';
import { createDiagnosticScope, type DiagnosticScope } from '@kev-browser-agent-kit/workspace/diagnostics';
import { managedDeliveryTool } from '@kev-browser-agent-kit/workspace/delivery';
import type { InstalledCachePolicy, ManagedBundle, ManagedVfsImage } from '@kev-browser-agent-kit/workspace/delivery';

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
  bundle?: ManagedBundle;
  image?: ManagedVfsImage;
  dependencies: DependencyProvenance;
  opencode: PreparedOpenCode;
  preview: NodeLaunchOptions;
  project: Record<string, ProjectFile>;
  /** App-selected editable paths, separate from generated dependency inputs. */
  sourcePaths?: string[];
  /** Added at delivery by the server adapter's `modelCatalog` option; never written by preparation. */
  modelCatalog?: Record<string, OpenCodeCandidateModel>;
  editorDefaultModel?: string;
}

/** Derived locks reference these binary inputs relative to the project root. */
export function validatePreparedBackendArchives(manifest: Pick<PreparedManifest, 'dependencies' | 'assets'>) {
  for (const archive of manifest.dependencies.backendArchives ?? []) {
    if (archive.path !== `.browser-editor-backends/${archive.sha256}.tgz`) throw Error('Invalid prepared backend archive path');
    const asset = manifest.assets.find(entry => entry.destination === '/workspace/' + archive.path);
    if (asset?.kind !== 'file' || asset.sha256 !== archive.sha256 || asset.bytes !== archive.bytes) throw Error('Prepared backend archive input missing or mismatched');
  }
}

export async function loadPrepared(base: string, signal: AbortSignal, diagnostics = createDiagnosticScope(), options: { cache?: RequestCache } = {}): Promise<PreparedManifest> {
  const response = await diagnostics.stage('manifest.fetch', () => fetch(base + 'manifest.json', { signal, cache: options.cache, headers: { 'x-editor-run-id': diagnostics.runId } }));
  if (!response.ok) throw Error(`Editor preparation unavailable: HTTP ${response.status}`);
  const manifest = await diagnostics.stage('manifest.decode', () => response.json()) as PreparedManifest;
  await diagnostics.stage('manifest.validate', async () => {
  if (manifest.format !== 'browser-editor-v2') throw Error('Unsupported editor preparation; regenerate with the current preparer');
  validateTree(manifest.assets);
  validatePreparedBackendArchives(manifest);
  await validatePreparedOpenCode(manifest);
  if (manifest.dependencies.policy.runtimeVersion !== manifest.runtimeVersion) throw Error('Prepared backend policy runtime mismatch');
  for (const path of Object.keys(manifest.project)) if (!path.startsWith('/') || path.split('/').slice(1).some(part => !part || part === '.' || part === '..' || /[\\\0]/.test(part)) || path === '/node_modules' || path.startsWith('/node_modules/')) throw Error('Invalid prepared source path');
  });
  if (manifest.image && manifest.image.format !== 'managed-vfs-image-v1') throw Error('Unsupported prepared managed image');
  diagnostics.record('manifest.summary', { entries: manifest.assets.length, projectFiles: Object.keys(manifest.project).length, bundleBytes: manifest.bundle?.bytes, imageBytes: manifest.image?.bytes, delivery: manifest.image ? 'vfs-image' : manifest.bundle ? 'bulk-tree' : 'individual-files' });
  return manifest;
}

export interface PreparedAppsOptions {
  experimentalReuseInstalled?: boolean;
  /** Opt-in stopped-tree audit. Caller must join ALL services before each install.
   * Invalid audits still redeliver conservatively; failed ownership proof rejects. */
  experimentalPreserveInstalledCaches?: { servicesStopped: true; policy: InstalledCachePolicy };
}

export function preparedApps(manifest: PreparedManifest, base: string, signal: AbortSignal, report: (text: string) => void, diagnostics: DiagnosticScope = createDiagnosticScope(), options: PreparedAppsOptions = {}): ToolDescriptor<void, void> {
  if (options.experimentalPreserveInstalledCaches && !options.experimentalReuseInstalled) throw Error('Cache preservation requires explicit installed reuse');
  validateTree(manifest.assets);
  validatePreparedBackendArchives(manifest);
  if (!manifest.bundle) throw Error('Prepared managed bundle is required; regenerate this editor preparation');
  const delivery = managedDeliveryTool({ format: 'managed-tree-v1', roots: treeRoots, entries: manifest.assets, bundle: manifest.bundle, image: manifest.image }, { baseUrl: base, signal, report,
    experimentalReuseInstalled: options.experimentalReuseInstalled ? { runtimeVersion: manifest.runtimeVersion,
      ...(options.experimentalPreserveInstalledCaches ? { preserveCaches: options.experimentalPreserveInstalledCaches } : { disposablePaths: ['/workspace/node_modules/.vite-temp', '/workspace/node_modules/.vite'] }),
      onResult: result => diagnostics.record('delivery.installed-environment', result) } : undefined });
  return { name: 'browser-editor-apps', version: manifest.runtimeVersion, async bind(context) {
    const install = await delivery.bind(context);
    return async () => {
      diagnostics.record('delivery.mode', { mode: 'managed-tree', entries: manifest.assets.length });
      await diagnostics.stage('delivery.install-tree', install);
      // Provision only a marker, never reset the entrypoint's fixed database directory.
      await context.installFile('/runtime-probe/.browser-editor', new TextEncoder().encode(openCodeCandidateLaunch.candidate));
    };
  } };
}
