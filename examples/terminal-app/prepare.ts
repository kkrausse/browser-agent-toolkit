// The project being edited is the TODO example next door: its dependencies become the guest
// image and its source is what the agent may edit. Only the output lands here.
//
// The image's application directory (`/app`) holds both halves of OpenCode 2.0.26: the server
// (`.runtime/opencode-2.0.26/`, built by ports/opencode/server) and, under `tui/`, the
// terminal client (the OpenCode port built for Node, `bun run build:tui:node` in
// ports/opencode). They are put together in `.editor/application/`.
//
//   BAT_OPENCODE_DIR          another server directory (with its application.json)
//   BAT_OPENCODE_CLIENT_DIR   another client directory (default: ../../ports/opencode/dist/node)
import { prepare } from '@kkrausse/browser-agent-toolkit/prepare'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const app = resolve(import.meta.dirname, '../todo-app')
const built = resolve(import.meta.dirname, '../../.runtime/opencode-2.0.26')
const server = process.env.BAT_OPENCODE_DIR ?? built
if (!existsSync(resolve(server, 'application.json'))) throw Error(`No OpenCode 2.0.26 server at ${server}: run \`bun run terminal\` in the repository root (it builds ports/opencode/server), or set BAT_OPENCODE_DIR.`)
const client = resolve(process.env.BAT_OPENCODE_CLIENT_DIR ?? join(import.meta.dirname, '../../ports/opencode/dist/node'))
if (!existsSync(join(client, 'main.js')) || !existsSync(join(client, 'opentui.wasm'))) throw Error(`No OpenCode client for Node at ${client}: in ports/opencode run \`bun run build:native\` and \`bun run build:tui:node\` (see its README.md), or set BAT_OPENCODE_CLIENT_DIR.`)

const walk = (directory: string, prefix = ''): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(join(directory, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`])
const described = JSON.parse(readFileSync(join(server, 'application.json'), 'utf8')) as { id: string; files: Record<string, { bytes: number; sha256: string }> }
const openCodeDir = resolve(import.meta.dirname, '.editor/application')
rmSync(openCodeDir, { recursive: true, force: true })
const files: typeof described.files = {}
for (const [name, source] of [...Object.keys(described.files).map(name => [name, join(server, name)] as const), ...walk(client).map(name => [`tui/${name}`, join(client, name)] as const)]) {
  mkdirSync(dirname(join(openCodeDir, name)), { recursive: true })
  cpSync(source, join(openCodeDir, name))
  files[name] = described.files[name] ?? { bytes: statSync(source).size, sha256: createHash('sha256').update(readFileSync(source)).digest('hex') }
}
writeFileSync(join(openCodeDir, 'application.json'), JSON.stringify({ id: `${described.id}+tui`, files }, null, 2) + '\n')
const order = resolve(app, 'editor-startup-order.txt')

const manifest = await prepare({
  appRoot: app,
  outDir: resolve(import.meta.dirname, '.editor/prepared'),
  source: ['src', 'vite.config.ts', 'react-router.config.ts', 'tsconfig.json', 'package.json'],
  openCodeDir,
  startupModules: 'startup-modules.json',
  startupOrder: existsSync(order) ? order : undefined,
})
console.log(`Prepared ${Object.keys(manifest.project).length} project files and image ${manifest.image?.file}`)
