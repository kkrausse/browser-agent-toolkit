import { prepare } from '@kkrausse/browser-agent-toolkit/prepare'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// What the agent may edit. Everything else the guest sees comes from the dependency image.
const source = ['src', 'vite.config.ts', 'react-router.config.ts', 'tsconfig.json', 'package.json']

// The pinned OpenCode server: $BAT_OPENCODE_DIR, else where the repository's `bun run setup` puts it.
const fetched = resolve(import.meta.dirname, '../../.runtime/opencode-2.0.3')
const openCodeDir = process.env.BAT_OPENCODE_DIR ?? (existsSync(fetched) ? fetched : undefined)
if (!openCodeDir && process.env.EDITOR_FAKE_HOST !== '1') console.warn('No OpenCode server found (run `bun run setup` in the repository root, or set BAT_OPENCODE_DIR): the editor will have a preview but no agent.')

const manifest = await prepare({
  appRoot: import.meta.dirname,
  outDir: '.editor/prepared',
  source,
  openCodeDir,
  // What a start-up reads from the dependency image, recorded from a real first open
  // (`bun bench/first-open/trace.ts`, see docs/experiments/2026-10-10-first-open-and-shell.md):
  // those 11 MB are laid out first, so a visitor's first open starts while the other
  // 228 MB are still downloading. Stale lines only cost speed; re-record after a
  // dependency upgrade.
  startupOrder: existsSync(resolve(import.meta.dirname, 'editor-startup-order.txt')) ? resolve(import.meta.dirname, 'editor-startup-order.txt') : undefined,
  // EDITOR_FAKE_HOST=1: no image; the programs run natively behind the dev fake host.
  manifestOnly: process.env.EDITOR_FAKE_HOST === '1',
})
console.log(`Prepared ${Object.keys(manifest.project).length} project files${manifest.image ? ` and image ${manifest.image.file}` : ' (manifest only, for the fake host)'}`)
