// Brings codex into the example: bundles the page side (codex/terminal.ts) and the Worker
// (codex/worker.ts), and puts wasm-term's built files and the shipped `codex-local` module
// beside them in the gitignored `.editor/codex/`, which server.ts serves under `/codex/`.
//
// wasm-term (`wasm-term/` of this repository) builds megabytes that are gitignored, the
// codex module above all (7 to 30 minutes); they have to exist. This says what is missing.
//
//   WASM_TERM_DIR   a wasm-term directory that has them (default: ../../wasm-term)
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const here = import.meta.dirname
const source = resolve(here, '../../wasm-term')
const built = resolve(process.env.WASM_TERM_DIR ?? source)
const out = resolve(here, '.editor/codex')
const site = join(built, 'ports/codex/dist/site-local')
const need: [path: string, how: string][] = [
  ['kernel/target/wasm32-unknown-unknown/release/wasm_term_kernel.wasm', 'cd wasm-term/web && bun install && bun run build'],
  ['ports/codex/dist/site-local/manifest.json', 'cd wasm-term/ports/codex && scripts/setup.sh && BIN=local scripts/ship.sh (wasm-term/README.md, "codex-local")'],
]
const missing = need.filter(([path]) => !existsSync(join(built, path)))
// The terminal emulator is a snapshot in the repository; nothing to build.
const ghostty = [join(source, 'third_party/ghostty-web/vendor/ghostty-vt.wasm'), join(source, 'third_party/ghostty-web/ghostty-vt.wasm')].find(existsSync)
if (!existsSync(join(source, 'web/node_modules/@random/ghostty-web/package.json'))) missing.push(['web/node_modules/@random/ghostty-web (in this checkout)', 'cd wasm-term/web && bun install'])
if (!ghostty) missing.push(['third_party/ghostty-web/…/ghostty-vt.wasm', 'this checkout has no wasm-term/third_party'])
if (missing.length) {
  console.error(`codex: wasm-term is not built at ${built} (WASM_TERM_DIR names a wasm-term directory that is):`)
  for (const [path, how] of missing) console.error(`  missing ${path}\n    ${how}`)
  process.exit(1)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const bundle = await Bun.build({
  entrypoints: [join(here, 'codex/terminal.ts'), join(here, 'codex/worker.ts')],
  outdir: out, target: 'browser', format: 'esm', minify: true,
  naming: { entry: '[name].[ext]' },
})
if (!bundle.success) throw new AggregateError(bundle.logs, 'Bundling codex failed')
// Bun names entries by their own file names; the Worker is asked for as codex-worker.js.
const worker = join(out, 'worker.js')
writeFileSync(join(out, 'codex-worker.js'), readFileSync(worker))
rmSync(worker)

// Big files are linked, not copied. The module is served precompressed (server.ts picks by Accept-Encoding).
const manifest = JSON.parse(readFileSync(join(site, 'manifest.json'), 'utf8')) as Record<string, { file: string; size: number }>
const module = manifest.default
if (!module) throw Error(`${site}/manifest.json names no default module`)
symlinkSync(ghostty!, join(out, 'ghostty-vt.wasm'))
symlinkSync(join(built, need[0]![0]), join(out, 'kernel.wasm'))
for (const suffix of ['.br', '.gz']) {
  if (!existsSync(join(site, module.file + suffix))) throw Error(`${site}/${module.file}${suffix} is missing: run scripts/ship.sh again`)
  symlinkSync(join(site, module.file + suffix), join(out, module.file + suffix))
}
writeFileSync(join(out, 'codex.json'), JSON.stringify({ module: module.file, bytes: module.size }))
console.log(`codex: ${module.file} (${(module.size / 1e6).toFixed(1)} MB) and wasm-term from ${built} -> ${out}`)
