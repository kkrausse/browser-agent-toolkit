#!/usr/bin/env bun
// Stage what an app vendors instead of a checkout of this repository: two npm tarballs.
//
//   bun scripts/release.ts [--out <dir>] [--skip-setup] [--allow-dirty]
//
//   kkrausse-browser-agent-toolkit-<version>-<commit>.tgz
//     the package (`dist/`, with the browser runtime in `dist/runtime/`) plus `prepare/`:
//     the guest policy with the shim packages it names, and the pinned OpenCode server.
//     `prepare()` finds all of it beside itself; nothing is downloaded at prepare time
//     except the app's own npm packages.
//   kkrausse-browser-agent-prepare-<platform>-<arch>-<version>-<commit>.tgz
//     the `bat-prepare` executable for the machine this script runs on. `prepare()` resolves
//     `@kkrausse/browser-agent-prepare-<platform>-<arch>` for the machine it runs on; on any
//     other machine build the tool there (`cargo build --release -p bat-prepare`, or run this
//     script there) and install that package, or set BAT_PREPARE.
//
// Both carry BUILD-PROVENANCE.json (commit, dirty flag, tool versions, file digests). The
// commit is in the file names so a package manager never reuses an older unpacked copy of
// the same version. Default output: `.release/<version>-<commit>/`.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setup } from './setup'

const root = resolve(import.meta.dir, '..')
const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const value = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined }

function sh(command: string[], cwd = root): string {
  const result = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'inherit' })
  if (result.exitCode !== 0) throw Error(`${command.join(' ')} failed (exit ${result.exitCode})`)
  return result.stdout.toString().trim()
}
const sha256 = (path: string) => new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex')

const commit = sh(['git', 'rev-parse', 'HEAD'])
const dirty = sh(['git', 'status', '--porcelain', '--untracked-files=no']) !== ''
if (dirty && !flag('--allow-dirty')) throw Error('Tracked files are modified: commit first, or pass --allow-dirty (the archives are then marked as not reproducible from the commit).')
const toolkit = JSON.parse(readFileSync(join(root, 'packages/toolkit/package.json'), 'utf8'))
const stamp = commit.slice(0, 7) + (dirty ? '-dirty' : '')
const out = resolve(value('--out') ?? join(root, '.release', `${toolkit.version}-${stamp}`))

const built = flag('--skip-setup')
  ? { env: { BAT_PREPARE: join(root, process.env.CARGO_TARGET_DIR ?? 'target', 'release/bat-prepare'), BAT_OPENCODE_DIR: process.env.BAT_OPENCODE_DIR ?? join(root, '.runtime/opencode-2.0.3') } }
  : await setup()

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const provenance = (files: Record<string, string>) => JSON.stringify({
  repository: 'kkrausse/browser-agent-toolkit', branch: sh(['git', 'rev-parse', '--abbrev-ref', 'HEAD']), commit, sourceDirty: dirty,
  builtAt: new Date().toISOString(), host: `${process.platform}-${process.arch}`,
  tools: { bun: Bun.version, rustc: sh(['rustc', '--version']), cargo: sh(['cargo', '--version']) },
  files,
}, null, 2) + '\n'

function pack(stage: string, name: string): string {
  // `bun pm pack` names the archive after the package and its version; the commit is added.
  const printed = sh(['bun', 'pm', 'pack', '--destination', out, '--quiet'], stage).split('\n').pop()!.trim()
  const made = existsSync(printed) ? printed : join(out, printed)
  const target = join(out, `${name}-${toolkit.version}-${stamp}.tgz`)
  renameSync(made, target)
  return target
}

// 1. The toolkit package.
const stage = join(out, 'stage/toolkit')
mkdirSync(stage, { recursive: true })
const dist = join(root, 'packages/toolkit/dist')
if (!existsSync(join(dist, 'runtime/host.js'))) throw Error('packages/toolkit/dist has no runtime: run `bun run setup` (the toolkit build copies runtime/dist into it).')
cpSync(dist, join(stage, 'dist'), { recursive: true })
for (const name of ['README.md', 'NOTICES.md', 'LICENSE.upstream', 'LICENSE.marked', 'LICENSE.shadcn']) cpSync(join(root, 'packages/toolkit', name), join(stage, name))
const prepareDir = join(stage, 'prepare')
cpSync(join(root, 'packages/guest-shims'), join(prepareDir, 'guest-shims'), { recursive: true, filter: source => !source.includes('/node_modules') })
// The policy's `dir:` paths are relative to the policy file: in the package the shims sit beside it.
const policyText = readFileSync(join(root, 'crates/bat-prepare/data/guest-policy.json'), 'utf8')
const packagedPolicy = policyText.replaceAll('dir:../../../packages/guest-shims/', 'dir:guest-shims/')
if (packagedPolicy.includes('dir:../')) throw Error('The guest policy names a directory outside packages/guest-shims; scripts/release.ts does not package it.')
writeFileSync(join(prepareDir, 'guest-policy.json'), packagedPolicy)
const openCode = join(prepareDir, 'opencode')
mkdirSync(openCode)
const pinned = JSON.parse(policyText).application.files as Record<string, { bytes: number; sha256: string }>
for (const [name, expected] of Object.entries(pinned)) {
  const source = join(built.env.BAT_OPENCODE_DIR, name)
  if (sha256(source) !== expected.sha256) throw Error(`${source} is not the file the guest policy pins`)
  cpSync(source, join(openCode, name))
}
cpSync(join(root, 'third_party/NOTICES.md'), join(prepareDir, 'NOTICES.md'))
const runtimeFiles = Object.fromEntries(readdirSync(join(stage, 'dist/runtime')).sort().map(name => [`dist/runtime/${name}`, sha256(join(stage, 'dist/runtime', name))]))
writeFileSync(join(stage, 'BUILD-PROVENANCE.json'), provenance({ ...runtimeFiles, 'prepare/guest-policy.json': sha256(join(prepareDir, 'guest-policy.json')) }))
const { devDependencies: _dev, scripts: _scripts, ...manifest } = toolkit
writeFileSync(join(stage, 'package.json'), JSON.stringify({ ...manifest, files: [...toolkit.files, 'prepare', 'BUILD-PROVENANCE.json'] }, null, 2) + '\n')
const toolkitArchive = pack(stage, 'kkrausse-browser-agent-toolkit')

// 2. The prepare tool for this machine.
const platform = `${process.platform}-${process.arch}`
const binStage = join(out, `stage/prepare-${platform}`)
mkdirSync(binStage, { recursive: true })
cpSync(built.env.BAT_PREPARE, join(binStage, 'bat-prepare'))
// Debug symbols are most of the file; a stripped copy runs the same.
if (Bun.spawnSync(['strip', join(binStage, 'bat-prepare')]).exitCode !== 0) console.warn('[release] strip failed or is missing: the executable is packaged as built')
chmodSync(join(binStage, 'bat-prepare'), 0o755)
if (sh([join(binStage, 'bat-prepare'), '--help']).length === 0) throw Error('The packaged bat-prepare does not run')
writeFileSync(join(binStage, 'BUILD-PROVENANCE.json'), provenance({ 'bat-prepare': sha256(join(binStage, 'bat-prepare')) }))
writeFileSync(join(binStage, 'README.md'), `# bat-prepare for ${platform}\n\nThe native prepare tool of @kkrausse/browser-agent-toolkit ${toolkit.version}, built from commit ${commit}.\n\`prepare()\` of the toolkit finds it here. It needs \`bun\` and \`node\` (24) on PATH at prepare time;\nbubblewrap is used when present. Built on ${sh(['uname', '-sr'])}: it links the C library dynamically, so an\nolder system may refuse it; build the tool there instead (\`cargo build --release -p bat-prepare\`\nin the toolkit repository) and set BAT_PREPARE.\n`)
writeFileSync(join(binStage, 'package.json'), JSON.stringify({
  name: `@kkrausse/browser-agent-prepare-${platform}`, version: toolkit.version, license: 'MIT',
  description: `bat-prepare executable for ${platform} (browser-agent-toolkit ${commit.slice(0, 7)})`,
  files: ['bat-prepare', 'README.md', 'BUILD-PROVENANCE.json'],
}, null, 2) + '\n')
const binArchive = pack(binStage, `kkrausse-browser-agent-prepare-${platform}`)

rmSync(join(out, 'stage'), { recursive: true, force: true })
console.log(`[release] commit ${commit}${dirty ? ' (dirty)' : ''}`)
for (const archive of [toolkitArchive, binArchive]) console.log(`[release] ${archive}  ${(statSync(archive).size / 1e6).toFixed(1)} MB  sha256 ${sha256(archive)}`)
