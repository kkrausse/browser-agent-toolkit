// Brings in the terminal display: the page component of packages/terminal (display.ts, a
// ghostty-web terminal that takes bytes and reports input and size) bundled as one module, and
// ghostty-web's terminal core, into the gitignored `.display/`, which is published as
// `display/`. The OpenCode client is not here: it is part of the prepared image (prepare.ts).
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../packages/terminal')
const out = resolve(import.meta.dirname, '.display')
const core = join(root, 'ghostty-web/vendor/ghostty-vt.wasm')
if (!existsSync(core)) throw Error(`No terminal display at ${root}: missing ghostty-web/vendor/ghostty-vt.wasm`)
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const built = await Bun.build({ entrypoints: [join(root, 'display.ts')], outdir: out, target: 'browser', format: 'esm', naming: '[name].[ext]' })
if (!built.success) throw new AggregateError(built.logs, 'Bundling the terminal display failed')
cpSync(core, join(out, 'ghostty-vt.wasm'))
console.log(`display: ${root} -> ${out}`)
