// The project being edited is the TODO example next door: its dependencies become the guest
// image and its source is what the agent may edit. Only the output lands here.
import { prepare } from '@kkrausse/browser-agent-toolkit/prepare'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const app = resolve(import.meta.dirname, '../todo-app')
// The server of the client's version (wasm-term's TUI is 2.0.26), not the toolkit's default 2.0.3.
const built = resolve(import.meta.dirname, '../../.runtime/opencode-2.0.26')
const openCodeDir = process.env.BAT_OPENCODE_DIR ?? (existsSync(resolve(built, 'application.json')) ? built : undefined)
if (!openCodeDir) throw Error('No OpenCode 2.0.26 server found: run `bun run terminal` in the repository root (it builds scripts/opencode-server), or set BAT_OPENCODE_DIR.')
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
