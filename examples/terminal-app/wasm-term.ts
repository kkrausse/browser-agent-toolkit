// Brings in the terminal half: wasm-term (the pty machine, the ghostty-web terminal and the
// OpenCode TUI built for it) is `wasm-term/` of this repository; its build outputs are
// megabytes and gitignored. This bundles its page wiring and copies its built files
// into the gitignored `.wasm-term/`, which the server serves under `/wasm-term/`.
//
//   WASM_TERM_DIR   another wasm-term directory (default: ../../wasm-term)
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const root = resolve(process.env.WASM_TERM_DIR ?? join(import.meta.dirname, '../../wasm-term'))
const out = resolve(import.meta.dirname, '.wasm-term')
const need: [path: string, how: string][] = [
  ['web/embed.ts', 'this checkout has no wasm-term/ (it is on branch `wasm-term`)'],
  ['web/node_modules/@random/ghostty-web/package.json', 'cd web && bun install'],
  ['kernel/target/wasm32-unknown-unknown/release/wasm_term_kernel.wasm', 'cd web && bun run build'],
  ['ports/opencode/dist/site/guest.js', 'cd ports/opencode && bun run build:native && bun run build:tui (see ports/opencode/NOTES.md)'],
  ['ports/opencode/dist/site/opentui.wasm', 'cd ports/opencode && bun run build:native'],
]
const missing = need.filter(([path]) => !existsSync(join(root, path)))
if (missing.length) {
  console.error(`wasm-term is not ready at ${root} (WASM_TERM_DIR names another wasm-term directory):`)
  for (const [path, how] of missing) console.error(`  missing ${path}\n    ${how}`)
  process.exit(1)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const built = await Bun.build({
  entrypoints: [join(root, 'web/embed.ts'), join(root, 'host/js-worker.ts')],
  outdir: out, target: 'browser', format: 'esm', naming: '[name].[ext]',
})
if (!built.success) throw new AggregateError(built.logs, 'Bundling wasm-term failed')
const ghostty = createRequire(join(root, 'web/package.json')).resolve('@random/ghostty-web/ghostty-vt.wasm')
cpSync(ghostty, join(out, 'ghostty-vt.wasm'))
cpSync(join(root, need[2]![0]), join(out, 'kernel.wasm'))
cpSync(join(root, 'ports/opencode/dist/site'), join(out, 'opencode'), { recursive: true, filter: source => !source.endsWith('.map') })
console.log(`wasm-term: ${root} -> ${out}`)
