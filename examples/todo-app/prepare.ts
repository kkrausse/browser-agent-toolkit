import { packagedOpenCodeDirectory, prepareBrowserEditorDependencies, readTailwindWasmCandidate, writeBrowserEditorSource } from '@kev-browser-agent-kit/opencode-chat/prepare'
import { readRuntimeAssets, readRuntimeBackendPolicy } from '@kev-browser-agent-kit/workspace/assets'
import { cacheMatches, fingerprint, markCache, resetDirectory } from '@kev-browser-agent-kit/workspace/prepare'
import { resolve } from 'node:path'

// Source-built Tailwind backend: the toolkit's retained candidate (root `bun run setup`)
// unless both variables select another receipt explicitly.
let receipt = process.env.TAILWIND_CANDIDATE_RECEIPT
let digest = process.env.TAILWIND_CANDIDATE_SHA256
if (!!receipt !== !!digest) throw Error('Set both TAILWIND_CANDIDATE_RECEIPT and TAILWIND_CANDIDATE_SHA256 to select a source-built backend')
if (!receipt) {
  const candidates = resolve(import.meta.dirname, '../../vivari/.runtime/tailwind-wasm-candidate')
  const pointer = await Bun.file(resolve(candidates, 'current.json')).json().catch(() => {
    throw Error('Tailwind backend candidate missing. Run `bun run setup` at the repository root (or `bun vivari/scripts/setup-tailwind-candidate.ts`).')
  })
  receipt = resolve(candidates, pointer.receipt)
  digest = pointer.receiptSha256
}
const backend = readTailwindWasmCandidate(resolve(receipt), digest!)
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
  const backendArchives = [{
    override: backend.packageName, packageName: backend.packageName, version: backend.packageVersion,
    archivePath: backend.archive.path, sha256: backend.archive.sha256, sha512: backend.archive.sha512,
    source: { repository: backend.source.repository, revision: backend.source.revision, buildReceiptSha256: backend.receiptSha256 },
  }]
  // The installed preparer code decides the manifest's shape, so it is a cache input too.
  const preparers = await Promise.all(['opencode-chat/prepare', 'workspace/prepare', 'workspace/assets'].map(async name =>
    new Bun.CryptoHasher('sha256').update(await Bun.file(Bun.resolveSync('@kev-browser-agent-kit/' + name, import.meta.dirname)).arrayBuffer()).digest('hex')))
  const dependencyFingerprint = await fingerprint({
    rootDir: import.meta.dirname,
    files: ['package.json', 'bun.lock'],
    values: {
      preparers,
      runtimeVersion: runtime.version,
      backendPolicySha256: policy.sha256,
      backendArchives: backendArchives.map(({ archivePath: _path, ...identity }) => identity),
      openCodeReceiptSha256,
    },
  })
  const receiptPath = resolve(config.outputDir, 'dependencies-cache.json')
  const manifestPath = resolve(config.outputDir, 'prepared/manifest.json')
  // The manifest exactly as dependency preparation generated it, kept outside the served directory.
  const generatedManifestPath = resolve(config.outputDir, 'dependencies-manifest.json')
  let dependenciesCurrent = await cacheMatches({ receiptPath, fingerprint: dependencyFingerprint, outputs: [generatedManifestPath] })
  if (dependenciesCurrent) {
    const existing = await Bun.file(generatedManifestPath).json()
    dependenciesCurrent = typeof existing.bundle?.file === 'string'
      && await cacheMatches({ receiptPath, fingerprint: dependencyFingerprint, outputs: [generatedManifestPath, resolve(config.outputDir, 'prepared', existing.bundle.file)] })
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
    await Bun.write(generatedManifestPath, Bun.file(manifestPath))
    await markCache({
      receiptPath,
      fingerprint: dependencyFingerprint,
      outputs: [generatedManifestPath, resolve(config.outputDir, 'prepared', manifest.bundle!.file)],
    })
  }
  // Always rebuild the served manifest from the generated one plus current source, so an
  // edited or older manifest never survives. This path never invokes dependency installation.
  await Bun.write(manifestPath, Bun.file(generatedManifestPath))
  await writeBrowserEditorSource({ appRoot: import.meta.dirname, output: config.outputDir, source })
}

await runBuild()
