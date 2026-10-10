#!/usr/bin/env bun
// Build everything the TODO example needs, in order. Each step is incremental, so running
// it again after a change costs only what changed (about 8 s when nothing did).
//
//   bun run setup            build
//   bun run editor           build, then prepare + build + serve examples/todo-app (PORT, default 3000)
//
// Needs: bun, cargo with the targets wasm32-wasip1-threads and wasm32-unknown-unknown
// (`rustup target add …`), node 24 and network access the first time (dependencies and the
// pinned OpenCode 2.0.3 server). `CARGO_TARGET_DIR` is respected (default `target/`).
//
//   1. bun install
//   2. OpenCode server artefact → .runtime/opencode-2.0.3/ ($BAT_OPENCODE_DIR overrides;
//      copied from a sibling checkout of the old toolkit when one exists, else downloaded
//      from the checksummed release asset)
//   3. kernel.wasm, bat_modules.wasm, bat_node_native.wasm, bat_sh.wasm, the bat-prepare CLI
//   4. runtime bundles → runtime/dist/
//   5. the toolkit package → packages/toolkit/dist/
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const target = resolve(root, process.env.CARGO_TARGET_DIR ?? 'target')
const openCodeFiles = ['server.js', 'tree-sitter.wasm', 'tree-sitter-bash.wasm', 'tree-sitter-powershell.wasm']
const openCodeRelease = {
  url: 'https://github.com/kkrausse/browser-agent-toolkit/releases/download/opencode-input-2.0.3/opencode-2.0.3-live-catalog-qualified.tgz',
  sha256: '9f0884636fd81befda7de73103e6e09f2efb438acb7250a95f7e4433d386f0c8',
  payload: '.runtime/opencode-bun-server',
}

async function run(label: string, command: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<void> {
  const started = performance.now()
  const child = Bun.spawn(command, { cwd: options.cwd ?? root, env: { ...process.env, ...options.env }, stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' })
  const code = await child.exited
  if (code !== 0) throw Error(`${label} failed (exit ${code}): ${command.join(' ')}`)
  console.log(`[setup] ${label}: ${((performance.now() - started) / 1000).toFixed(1)} s`)
}

const hasOpenCode = (dir: string) => openCodeFiles.every(name => existsSync(join(dir, name)))

/** The directory holding the pinned OpenCode server; bat-prepare checks every file against the policy's hashes. */
async function openCodeDir(): Promise<string> {
  if (process.env.BAT_OPENCODE_DIR) {
    if (!hasOpenCode(process.env.BAT_OPENCODE_DIR)) throw Error(`BAT_OPENCODE_DIR has no ${openCodeFiles.join(', ')}: ${process.env.BAT_OPENCODE_DIR}`)
    return resolve(process.env.BAT_OPENCODE_DIR)
  }
  const local = join(root, '.runtime/opencode-2.0.3')
  if (hasOpenCode(local)) return local
  const copy = (from: string) => {
    mkdirSync(local, { recursive: true })
    for (const name of openCodeFiles) cpSync(join(from, name), join(local, name))
  }
  const sibling = resolve(root, '../browser-agent-toolkit/vivari/.runtime/opencode-release-2.0.3', openCodeRelease.payload)
  if (hasOpenCode(sibling)) {
    copy(sibling)
    console.log(`[setup] OpenCode 2.0.3 copied from ${sibling}`)
    return local
  }
  const response = await fetch(openCodeRelease.url, { signal: AbortSignal.timeout(300_000) })
  if (!response.ok) throw Error(`OpenCode download: HTTP ${response.status} ${openCodeRelease.url}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (new Bun.CryptoHasher('sha256').update(bytes).digest('hex') !== openCodeRelease.sha256) throw Error('OpenCode archive does not match its pinned sha256')
  // Extracted into a fresh directory of its own; only the four named files are taken from it.
  const scratch = mkdtempSync(join(tmpdir(), 'bat-opencode-'))
  try {
    await Bun.write(join(scratch, 'input.tgz'), bytes)
    mkdirSync(join(scratch, 'payload'))
    await run('extract OpenCode', ['tar', '-xzf', join(scratch, 'input.tgz'), '-C', join(scratch, 'payload')])
    const payload = join(scratch, 'payload', openCodeRelease.payload)
    if (!hasOpenCode(payload)) throw Error(`OpenCode archive has no ${openCodeRelease.payload}/server.js`)
    copy(payload)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  console.log(`[setup] OpenCode 2.0.3 downloaded to ${local}`)
  return local
}

export async function setup(): Promise<{ env: Record<string, string> }> {
  await run('bun install', ['bun', 'install'])
  const openCode = await openCodeDir()
  await run('kernel.wasm', ['bash', 'crates/bat-kernel/build.sh'], { env: { CARGO_TARGET_DIR: target } })
  await run('bat_modules.wasm', ['sh', 'crates/bat-modules/build-wasm.sh'], { env: { CARGO_TARGET_DIR: target } })
  await run('bat_node_native.wasm', ['sh', 'crates/bat-node-native/build-wasm.sh'], { env: { CARGO_TARGET_DIR: join(target, 'native-wasm') } })
  await run('bat_sh.wasm', ['sh', 'crates/bat-sh/build-wasm.sh'], { env: { CARGO_TARGET_DIR: join(target, 'sh-wasm') } })
  await run('bat-prepare', ['cargo', 'build', '--release', '-q', '-p', 'bat-prepare'], { env: { CARGO_TARGET_DIR: target } })
  const kernel = join(target, 'wasm32-wasip1-threads/release/bat_kernel.wasm')
  await run('runtime bundles', ['bun', 'runtime/build.ts'])
  await run('runtime host bundles', ['bun', 'runtime/src/host/build.ts'], { env: { BAT_KERNEL_WASM: kernel } })
  await run('toolkit', ['bun', 'run', 'build'], { cwd: join(root, 'packages/toolkit') })
  return { env: { BAT_PREPARE: join(target, 'release/bat-prepare'), BAT_OPENCODE_DIR: openCode, BAT_RUNTIME_DIR: join(root, 'runtime/dist') } }
}

if (import.meta.main) {
  const { env } = await setup()
  if (process.argv[2] === 'editor') {
    // The example's own script: prepare (image, manifest, runtime assets), build, serve.
    const child = Bun.spawn(['bun', 'run', 'editor'], { cwd: join(root, 'examples/todo-app'), env: { ...process.env, ...env }, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' })
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
    process.exit(await child.exited)
  }
  console.log('[setup] done. Start the example with `bun run editor` (or `bun run editor` in examples/todo-app with BAT_PREPARE and BAT_OPENCODE_DIR set).')
}
