// Builds the whole example into `dist/`: a directory of static files with an `index.html`,
// to be served by anything, at any path (`bun server.ts`, `bunx serve dist`, a file shelf).
//
//   index.html, main.js     the page
//   sw.js                   its service worker (isolation headers, inflating, the preview)
//   todo-api.js             the TODO app's backend, a guest program
//   wasm-term/              the terminal half (from `bun run wasm-term`)
//   editor/                 the prepared runtime, image and manifest (from `bun run prepare:editor`)
//
// Big compressible files are shipped once, gzip-compressed (`<name>.gz`, no `<name>`); the
// service worker inflates them. gzip because it is what `DecompressionStream` has: the
// 240 MB dependency image is 45 MB (zstd: 32 MB, which Chrome 154 can only decode in its
// network stack, i.e. with a server that sets `Content-Encoding`).
//
//   OUT_DIR     another output directory (default dist/)
//   MODEL_URL   the default `?model=` (and its `/diag` collector) of the built page,
//               for a page that is not published beside its mock
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

const here = import.meta.dirname
const out = resolve(here, process.env.OUT_DIR ?? 'dist')
for (const [path, how] of [['.wasm-term/embed.js', 'bun run wasm-term'], ['.editor/prepared/manifest.json', 'bun run prepare:editor']] as const) {
  if (!existsSync(resolve(here, path))) throw Error(`Missing ${path}: run \`${how}\` in examples/terminal-app (or \`bun run terminal\` in the repository root).`)
}

const walk = (directory: string, prefix = ''): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(join(directory, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`])

// What is copied: published path → source. Not the zstd copies (for a server that negotiates
// encodings) and not the runtime's test page script.
const files = new Map<string, string>([['index.html', resolve(here, 'index.html')]])
for (const path of walk(resolve(here, '.wasm-term'))) files.set(`wasm-term/${path}`, resolve(here, '.wasm-term', path))
for (const path of walk(resolve(here, '.editor/prepared'))) {
  if (path.endsWith('.zst') || path === 'runtime/bat-harness.js') continue
  files.set(`editor/${path}`, resolve(here, '.editor/prepared', path))
}
// Loaded before the service worker controls anything, or by the browser itself: never compressed.
const plain = new Set(['index.html', 'editor/runtime/sw.js'])
const compressible = new Set(['.js', '.wasm', '.json', '.batimg', '.scm'])
const gzipped: string[] = []
const kept = new Set<string>()
let copied = 0, compressed = 0, reused = 0
for (const [path, source] of files) {
  const from = statSync(source)
  const gzip = !plain.has(path) && compressible.has(extname(path)) && from.size >= 16 * 1024
  const target = join(out, gzip ? `${path}.gz` : path)
  kept.add(gzip ? `${path}.gz` : path)
  if (gzip) gzipped.push(path)
  // The image takes 13 s to compress and its name is its content.
  if (existsSync(target) && statSync(target).mtimeMs > from.mtimeMs && (gzip || statSync(target).size === from.size)) { reused++; continue }
  mkdirSync(dirname(target), { recursive: true })
  if (gzip) { await pipeline(createReadStream(source), createGzip({ level: 9 }), createWriteStream(target)); compressed++ }
  else { copyFileSync(source, target); copied++ }
}

async function bundle(entry: string, name: string, options: Partial<Parameters<typeof Bun.build>[0]>) {
  const result = await Bun.build({ entrypoints: [resolve(here, entry)], target: 'browser', format: 'esm', sourcemap: 'none', ...options })
  if (!result.success) throw new AggregateError(result.logs, `Building ${entry} failed`)
  await Bun.write(join(out, name), await result.outputs[0]!.text())
  kept.add(name)
}
await bundle('src/main.ts', 'main.js', { define: { 'process.env.MODEL_URL': JSON.stringify(process.env.MODEL_URL ?? '') } })
await bundle('sw.ts', 'sw.js', { format: 'iife', define: { GZIPPED: JSON.stringify(gzipped) } })
await bundle('todo-api.ts', 'todo-api.js', { target: 'node' })

for (const path of walk(out)) if (!kept.has(path)) rmSync(join(out, path))
const bytes = [...kept].reduce((sum, path) => sum + statSync(join(out, path)).size, 0)
console.log(`Built ${out}: ${kept.size} files, ${(bytes / 1e6).toFixed(1)} MB (${compressed} compressed now, ${reused} unchanged, ${copied} copied; ${gzipped.length} shipped as .gz)${process.env.MODEL_URL ? `; default model ${process.env.MODEL_URL}` : ''}`)
