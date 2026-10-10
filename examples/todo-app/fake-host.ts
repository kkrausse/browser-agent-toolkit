import { createFakeHost } from '@kkrausse/browser-agent-toolkit/fake/server'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Development only: run the editor's two programs natively (see the toolkit's `./fake`).
 *   EDITOR_FAKE_DIR        scratch directory holding /workspace and /app (default /tmp/bat-toolkit-todo)
 *   BAT_OPENCODE_DIR       directory with the pinned OpenCode server.js and tree-sitter wasm
 *   EDITOR_PREVIEW_PORT, EDITOR_AGENT_PORT   native loopback ports for guest ports 5173 and 4096
 */
export async function createTodoFakeHost(hostOrigin: string) {
  const directory = resolve(process.env.EDITOR_FAKE_DIR ?? '/tmp/bat-toolkit-todo')
  const openCode = process.env.BAT_OPENCODE_DIR
    ?? resolve(import.meta.dirname, '../../../browser-agent-toolkit/vivari/.runtime/opencode-release-2.0.3/.runtime/opencode-bun-server')
  const app = resolve(directory, 'app')
  if (!existsSync(resolve(app, 'server.js'))) {
    if (!existsSync(resolve(openCode, 'server.js'))) throw Error(`OpenCode server.js not found in ${openCode}; set BAT_OPENCODE_DIR`)
    await mkdir(app, { recursive: true })
    // The artifact listens on a fixed port. Natively that port must be ours to choose, so
    // this scratch copy (never the artifact) reads it from the fake host's environment.
    const bundle = await readFile(resolve(openCode, 'server.js'), 'utf8')
    const patched = bundle.replace('\n    port: 4096,\n', '\n    port: Number(process.env.BAT_FAKE_PORT_4096 ?? 4096),\n')
    if (patched === bundle) throw Error('OpenCode server.js no longer has the expected port line')
    await writeFile(resolve(app, 'server.js'), patched)
    for (const name of ['tree-sitter.wasm', 'tree-sitter-bash.wasm', 'tree-sitter-powershell.wasm']) await copyFile(resolve(openCode, name), resolve(app, name))
  }
  return createFakeHost({
    hostOrigin,
    mounts: { '/workspace': resolve(directory, 'workspace'), '/app': app },
    // The stand-in for the dependency image.
    links: { '/workspace/node_modules': resolve(import.meta.dirname, 'node_modules') },
    ports: { 5173: Number(process.env.EDITOR_PREVIEW_PORT) || 4111, 4096: Number(process.env.EDITOR_AGENT_PORT) || 4112 },
  })
}
