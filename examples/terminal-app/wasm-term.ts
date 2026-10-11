// Brings in the terminal display: wasm-term's page component (web/display.ts, a ghostty-web
// terminal that takes bytes and reports input and size) bundled as one module, and ghostty-web's
// terminal core, into the gitignored `.wasm-term/`, which is published as `wasm-term/`. Nothing
// else of wasm-term is on the page: the OpenCode client is part of the prepared image (prepare.ts).
//
//   WASM_TERM_DIR   another wasm-term directory (default: ../../wasm-term)
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const root = resolve(process.env.WASM_TERM_DIR ?? join(import.meta.dirname, '../../wasm-term'))
const out = resolve(import.meta.dirname, '.wasm-term')
if (!existsSync(join(root, 'web/node_modules/@random/ghostty-web/package.json'))) {
  console.error(`wasm-term is not ready at ${root} (WASM_TERM_DIR names another wasm-term directory):\n  missing web/node_modules/@random/ghostty-web\n    cd web && bun install`)
  process.exit(1)
}
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const built = await Bun.build({ entrypoints: [join(root, 'web/display.ts')], outdir: out, target: 'browser', format: 'esm', naming: '[name].[ext]' })
if (!built.success) throw new AggregateError(built.logs, 'Bundling the terminal display failed')
cpSync(createRequire(join(root, 'web/package.json')).resolve('@random/ghostty-web/ghostty-vt.wasm'), join(out, 'ghostty-vt.wasm'))
console.log(`wasm-term: ${root} -> ${out}`)
