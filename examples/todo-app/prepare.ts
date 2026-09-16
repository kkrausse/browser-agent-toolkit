import { prepareBrowserEditor, readTailwindWasmCandidate } from '@kev-browser-agent-kit/opencode-chat/prepare'
import { resolve } from 'node:path'

const receipt = process.env.TAILWIND_CANDIDATE_RECEIPT
const digest = process.env.TAILWIND_CANDIDATE_SHA256
if (!!receipt !== !!digest) throw Error('Set both TAILWIND_CANDIDATE_RECEIPT and TAILWIND_CANDIDATE_SHA256 to select a source-built backend')
const backend = receipt ? readTailwindWasmCandidate(resolve(receipt), digest!) : undefined

await prepareBrowserEditor({
  appRoot: import.meta.dirname,
  output: resolve('.editor'),
  runtimeDirectory: process.env.RUNTIME_DIR ? resolve(process.env.RUNTIME_DIR) : resolve(import.meta.dirname, '../../workspace-api/dist/runtime'),
  openCodeDirectory: process.env.OPENCODE_PACKAGE_DIR ? resolve(process.env.OPENCODE_PACKAGE_DIR) : undefined,
  backendArchives: backend ? [{
    override: backend.packageName, packageName: backend.packageName, version: backend.packageVersion,
    archivePath: backend.archive.path, sha256: backend.archive.sha256, sha512: backend.archive.sha512,
    source: { repository: backend.source.repository, revision: backend.source.revision, buildReceiptSha256: backend.receiptSha256 },
  }] : undefined,
  source: ['src', 'vite.config.ts', 'react-router.config.ts', 'tsconfig.json'],
})
