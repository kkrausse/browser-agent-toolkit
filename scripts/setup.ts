#!/usr/bin/env bun
// Build everything the TODO example needs, in order. Each step is incremental, so running
// it again after a change costs only what changed (about 8 s when nothing did).
//
//   bun run setup            build
//   bun run editor           build, then prepare + build + serve examples/todo-app (PORT, default 3000)
//   bun run terminal         the same for examples/terminal-app (PORT, default 4310)
//
// Needs: bun, cargo with the targets wasm32-wasip1-threads and wasm32-unknown-unknown
// (`rustup target add …`), node 24 and network access the first time (dependencies and the
// OpenCode server packages). `CARGO_TARGET_DIR` is respected (default `target/`).
//
//   1. bun install
//   2. OpenCode server artefact → .runtime/opencode-2.0.26/ ($BAT_OPENCODE_DIR overrides):
//      bundled here from the published packages pinned in ports/opencode/server. Both
//      examples run it; the chat client and the terminal client are built for that version.
//   3. kernel.wasm, bat_modules.wasm, bat_node_native.wasm, bat_sh.wasm, the bat-prepare CLI
//   4. runtime bundles → runtime/dist/
//   5. the toolkit package → packages/toolkit/dist/, then its React package →
//      packages/react/dist/
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const target = resolve(root, process.env.CARGO_TARGET_DIR ?? 'target')
const openCodeFiles = ['server.js', 'tree-sitter.wasm', 'tree-sitter-bash.wasm', 'tree-sitter-powershell.wasm']
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
  return builtOpenCodeDir()
}

/** OpenCode 2.0.26, built from the published packages pinned in ports/opencode/server/bun.lock. */
async function builtOpenCodeDir(): Promise<string> {
  const recipe = join(root, 'ports/opencode/server')
  const lock = Bun.JSONC.parse(await Bun.file(join(recipe, 'bun.lock')).text()) as { packages: Record<string, unknown[]> }
  const local = join(root, '.runtime', String(lock.packages['@opencode/server']![0]).replace('@opencode/server@', 'opencode-'))
  // The directory describes itself once a build has finished (application.json is written last).
  if (hasOpenCode(local) && existsSync(join(local, 'application.json'))) return local
  await run('OpenCode packages', ['bun', 'install', '--frozen-lockfile', '--linker', 'isolated'], { cwd: recipe })
  await run('OpenCode server bundle', ['bun', 'build.ts', local], { cwd: recipe })
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
  await run('toolkit React package', ['bun', 'run', 'build'], { cwd: join(root, 'packages/react') })
  return { env: { BAT_PREPARE: join(target, 'release/bat-prepare'), BAT_OPENCODE_DIR: openCode, BAT_RUNTIME_DIR: join(root, 'runtime/dist') } }
}

if (import.meta.main) {
  const { env } = await setup()
  // `editor`: the TODO example; `terminal`: the same app with the OpenCode TUI (examples/terminal-app).
  const example = { editor: 'examples/todo-app', terminal: 'examples/terminal-app' }[process.argv[2] ?? '']
  if (example) {
    // The example's own script: prepare (image, manifest, runtime assets), build, serve.
    const child = Bun.spawn(['bun', 'run', 'editor'], { cwd: join(root, example), env: { ...process.env, ...env }, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' })
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
    process.exit(await child.exited)
  }
  console.log('[setup] done. Start the example with `bun run editor` (or `bun run editor` in examples/todo-app with BAT_PREPARE and BAT_OPENCODE_DIR set).')
}
