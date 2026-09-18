import { packagedOpenCodeDirectory, prepareBrowserEditorDependencies, readTailwindWasmCandidate, writeBrowserEditorSource } from '@kev-browser-agent-kit/opencode-chat/prepare'
import { readRuntimeAssets, readRuntimeBackendPolicy } from '@kev-browser-agent-kit/workspace/assets'
import { cacheMatches, fingerprint, markCache, resetDirectory } from '@kev-browser-agent-kit/workspace/prepare'
import { resolve } from 'node:path'

const receipt = process.env.TAILWIND_CANDIDATE_RECEIPT
const digest = process.env.TAILWIND_CANDIDATE_SHA256
if (!!receipt !== !!digest) throw Error('Set both TAILWIND_CANDIDATE_RECEIPT and TAILWIND_CANDIDATE_SHA256 to select a source-built backend')
const backend = receipt ? readTailwindWasmCandidate(resolve(receipt), digest!) : undefined
const config = {
  outputDir: resolve('.editor'),
  runtimeDir: process.env.RUNTIME_DIR ? resolve(process.env.RUNTIME_DIR) : resolve(import.meta.dirname, '../../workspace-api/dist/runtime'),
}
const source = ['src', 'vite.config.ts', 'react-router.config.ts', 'tsconfig.json']

async function runBuild() {
  const runtime = await readRuntimeAssets(config.runtimeDir)
  const policy = await readRuntimeBackendPolicy(config.runtimeDir)
  const openCodeDirectory = process.env.OPENCODE_PACKAGE_DIR ? resolve(process.env.OPENCODE_PACKAGE_DIR) : packagedOpenCodeDirectory
  const openCodeReceiptSha256 = new Bun.CryptoHasher('sha256')
    .update(await Bun.file(resolve(openCodeDirectory, 'build-receipt.json')).arrayBuffer())
    .digest('hex')
  const backendArchives = backend ? [{
    override: backend.packageName, packageName: backend.packageName, version: backend.packageVersion,
    archivePath: backend.archive.path, sha256: backend.archive.sha256, sha512: backend.archive.sha512,
    source: { repository: backend.source.repository, revision: backend.source.revision, buildReceiptSha256: backend.receiptSha256 },
  }] : undefined
  const dependencyFingerprint = await fingerprint({
    rootDir: import.meta.dirname,
    files: ['package.json', 'bun.lock'],
    values: {
      runtimeVersion: runtime.version,
      backendPolicySha256: policy.sha256,
      backendArchives: backendArchives?.map(({ archivePath: _path, ...identity }) => identity),
      openCodeReceiptSha256,
    },
  })
  const receiptPath = resolve(config.outputDir, 'dependencies-cache.json')
  const manifestPath = resolve(config.outputDir, 'prepared/manifest.json')
  let dependenciesCurrent = await cacheMatches({ receiptPath, fingerprint: dependencyFingerprint, outputs: [manifestPath] })
  if (dependenciesCurrent) {
    const existing = await Bun.file(manifestPath).json()
    dependenciesCurrent = typeof existing.bundle?.file === 'string'
      && await cacheMatches({ receiptPath, fingerprint: dependencyFingerprint, outputs: [manifestPath, resolve(config.outputDir, 'prepared', existing.bundle.file)] })
  }
  if (!dependenciesCurrent) {
    await resetDirectory(config.outputDir)
    const manifest = await prepareBrowserEditorDependencies({
      appRoot: import.meta.dirname,
      output: config.outputDir,
      runtimeDirectory: config.runtimeDir,
      openCodeDirectory,
      backendArchives,
    })
    await markCache({
      receiptPath,
      fingerprint: dependencyFingerprint,
      outputs: [manifestPath, resolve(config.outputDir, 'prepared', manifest.bundle!.file)],
    })
  }
  // Always refresh source; this path never invokes dependency installation.
  await writeBrowserEditorSource({ appRoot: import.meta.dirname, output: config.outputDir, source })
}

await runBuild()
