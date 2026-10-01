// Build a NEW UI staging directory only. Parent owns activation by copying the
// two served UI assets after backing up the live output; no host restart needed.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { assetHash } from '../../../workspace-api/scripts/runtime-assets'

const root = resolve(import.meta.dir, '../../..')
const input = resolve(process.argv[2] ?? '')
const output = resolve(process.argv[3] ?? '')
const candidateSource = process.argv[4] ? resolve(process.argv[4]) : undefined
if (!process.argv[2] || !process.argv[3]) throw Error('Usage: stage-single-kernel-live.ts <qualified-input> <new-staging-directory> [candidate-browser-source]')
const receipt = await Bun.file(join(input, 'receipt.json')).json()
if (receipt.offline || !receipt.prepared || receipt.topology?.policy !== 'single-kernel') throw Error('Require qualified prepared single-kernel input')
for (const [file, hash] of Object.entries(receipt.hashes)) {
  const path = resolve(input, file)
  if (!path.startsWith(input + '/') || assetHash(await readFile(path)) !== hash) throw Error('Qualification asset mismatch: ' + file)
}
await mkdir(output)
let browserLibrary = join(input, 'chat/browser.js')
if (candidateSource) {
  const candidate = await Bun.build({ entrypoints: [candidateSource], target: 'browser', outdir: join(output, 'candidate-chat'),
    external: ['@kev-browser-agent-kit/workspace', '@kev-browser-agent-kit/workspace/*'] })
  if (!candidate.success) throw new AggregateError(candidate.logs, 'Candidate browser library staging build')
  browserLibrary = join(output, 'candidate-chat/browser.js')
}
const built = await Bun.build({
  entrypoints: [join(import.meta.dir, 'single-kernel-live-client.tsx')], target: 'browser', outdir: output,
  jsx: { runtime: 'automatic', development: false },
  plugins: [{ name: 'frozen-workspace-and-compiled-ui', setup(builder) {
    builder.onResolve({ filter: /^@kev-browser-agent-kit\/workspace(?:\/(?:react|delivery|diagnostics))?$/ }, args => ({ path: join(input, 'workspace', (args.path.split('/')[2] ?? 'index') + '.js') }))
    builder.onResolve({ filter: /^@kev-browser-agent-kit\/opencode-chat\/browser$/ }, () => ({ path: browserLibrary }))
    builder.onResolve({ filter: /^@kev-browser-agent-kit\/opencode-chat\/(editor|react)$/ }, args => ({ path: join(root, 'opencode-chat/src', args.path.endsWith('/editor') ? 'editor.tsx' : 'react.tsx') }))
    builder.onResolve({ filter: /^@kev-browser-agent-kit\/opencode-chat\/editor.css$/ }, () => ({ path: join(root, 'opencode-chat/dist/editor.css') }))
    builder.onResolve({ filter: /^(?:react(?:\/.*)?|react-dom(?:\/.*)?)$/ }, args => ({ path: require.resolve(args.path, { paths: [join(root, 'opencode-chat')] }) }))
  } }],
})
if (!built.success) throw new AggregateError(built.logs, 'Workspace UI staging build')
const hashes = Object.fromEntries(await Promise.all(built.outputs.map(async file => [file.path, assetHash(await readFile(file.path))])))
await writeFile(join(output, 'ui-staging-receipt.json'), JSON.stringify({ input, runtimeVersion: receipt.version, runtimeRevision: receipt.revision, runtimeRebuilt: false, hostRestarted: false, compiledCSS: 'opencode-chat/dist/editor.css', browserLibrary: { path: browserLibrary, sha256: assetHash(await readFile(browserLibrary)), qualified: !candidateSource }, hashes }, null, 2), { flag: 'wx' })
console.log(output)
