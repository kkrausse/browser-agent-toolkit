// Builds the whole example into `dist/`: a directory of static files with an `index.html`,
// to be served by anything, at any path (`bun server.ts`, `bunx serve dist`, a file shelf).
//
//   index.html, main.js     the page
//   sw.js                   its service worker (isolation headers, inflating, the preview)
//   openai-jwks.json        a copy of OpenAI's public signing keys, for a page without a tunnel (see below; not in the public build)
//   client-tap.js           a preload module of the OpenCode client (the sign-in bar's source; not in the public build)
//   display/                the terminal display and its core (from `bun run display`)
//   editor/                 the prepared runtime, image (with the OpenCode server and client) and manifest (from `bun run prepare:editor`)
//
// Big compressible files are shipped once, gzip-compressed (`<name>.gz`, no `<name>`); the
// service worker inflates them. gzip because it is what `DecompressionStream` has: the
// 240 MB dependency image is 45 MB (zstd: 32 MB, which Chrome 154 can only decode in its
// network stack, i.e. with a server that sets `Content-Encoding`).
//
//   OUT_DIR     another output directory (default dist/)
//   MODEL_URL   the default `?model=` (and its `/diag` collector) of the built page,
//               for a page that is not published beside its mock
//   TUNNEL_URL  the default `?tunnel=` of the built page: the WebSocket address of a TCP relay
//               (`wss://relay.example/tcp`) that allows the page's origin
//   WISP_URL    the default `?wisp=` of the built page: a Wisp server (`wss://wisp.example/`), used
//               instead of TUNNEL_URL's relay unless the address says otherwise
//   PUBLIC=1    the public build, a page for strangers (README.md, "The public build"): no
//               default model endpoint (the server uses OpenCode's hosted free models), no
//               diagnostics unless the address asks, no ChatGPT sign-in bar, only opencode.ai
//               tunnelled. WISP_URL then defaults to the server below; MODEL_URL is refused
//   DIAG_PANEL=1  the page shows its diagnostics panel (src/diag.ts) without being asked by `?diag=1`:
//               for a build made to be tried on a device with no console
//   DIAG_URL    a collector (diag-collector.ts) that the panel posts its readout to, in any build; none by default
//   PUBLIC_MODEL  the hosted free model a fresh workspace of the public build starts on
//               (default below; empty for the server's own choice)
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

const here = import.meta.dirname
const isPublic = process.env.PUBLIC === '1'
// What carries opencode.ai for the public build: Mercury Workshop's public Wisp server, which
// is not ours and promises nothing (it carried opencode.ai:443 on 2026-10-11). `?wisp=<wss URL>`
// on the page names another Wisp server, `?tunnel=<wss URL>` a relay of packages/relay. The
// build named such a relay on Deno Deploy until that account was suspended on 2026-10-11.
const publicWisp = 'wss://wisp.mercurywork.shop/'
if (isPublic && process.env.MODEL_URL) throw Error('PUBLIC=1 builds a page with no default model endpoint: unset MODEL_URL')
// OpenCode Zen's free models come and go. This one answered on 2026-10-10; the page stops
// naming it once Zen no longer lists it (src/main.ts, hostedModel).
const publicModel = isPublic ? process.env.PUBLIC_MODEL ?? 'ling-3.1-flash-free' : ''
const modelUrl = process.env.MODEL_URL ?? '', tunnelUrl = process.env.TUNNEL_URL ?? '', wispUrl = process.env.WISP_URL ?? (isPublic ? publicWisp : '')
const out = resolve(here, process.env.OUT_DIR ?? 'dist')
for (const [path, how] of [['.display/display.js', 'bun run display'], ['.editor/prepared/manifest.json', 'bun run prepare:editor']] as const) {
  if (!existsSync(resolve(here, path))) throw Error(`Missing ${path}: run \`${how}\` in examples/terminal-app (or \`bun run terminal\` in the repository root).`)
}

const walk = (directory: string, prefix = ''): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(join(directory, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`])

// What is copied: published path → source. Not the zstd copies (for a server that negotiates
// encodings) and not the runtime's test page script.
const files = new Map<string, string>([['index.html', resolve(here, 'index.html')]])
for (const path of walk(resolve(here, '.display'))) files.set(`display/${path}`, resolve(here, '.display', path))
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

// OpenAI's signing keys (public), for the identity token of "Sign in with ChatGPT": the tab
// cannot read them from auth.openai.com, which sends no CORS headers for this document. Only
// a page without a tunnel uses the copy (with one, the server reads the real document). A
// copy made now goes stale when OpenAI rotates its keys; the sign-in then fails at the
// identity check ("invalid ID token") until the page is built again.
const keysUrl = 'https://auth.openai.com/.well-known/jwks.json'
const keys = isPublic ? undefined : await fetch(keysUrl, { signal: AbortSignal.timeout(20_000) }).then(async response => response.ok ? await response.json() as { keys?: unknown[] } : undefined, () => undefined)
if (isPublic) { /* no sign-in in the public build: no copy */ }
else if (Array.isArray(keys?.keys) && keys.keys.length) {
  await Bun.write(join(out, 'openai-jwks.json'), JSON.stringify(keys))
  kept.add('openai-jwks.json')
} else if (existsSync(join(out, 'openai-jwks.json'))) {
  kept.add('openai-jwks.json')
  console.warn(`Could not fetch ${keysUrl}: keeping the copy of an earlier build`)
} else console.warn(`Could not fetch ${keysUrl}: "Sign in with ChatGPT" will fail at its identity check in this build`)

async function bundle(entry: string, name: string, options: Partial<Parameters<typeof Bun.build>[0]>) {
  const result = await Bun.build({ entrypoints: [resolve(here, entry)], target: 'browser', format: 'esm', sourcemap: 'none', ...options })
  if (!result.success) throw new AggregateError(result.logs, `Building ${entry} failed`)
  await Bun.write(join(out, name), await result.outputs[0]!.text())
  kept.add(name)
}
await bundle('src/main.ts', 'main.js', { define: { 'process.env.MODEL_URL': JSON.stringify(modelUrl), 'process.env.TUNNEL_URL': JSON.stringify(tunnelUrl), 'process.env.WISP_URL': JSON.stringify(wispUrl), 'process.env.PUBLIC': JSON.stringify(isPublic ? '1' : ''), 'process.env.PUBLIC_MODEL': JSON.stringify(publicModel), 'process.env.DIAG_PANEL': JSON.stringify(process.env.DIAG_PANEL === '1' ? '1' : ''), 'process.env.DIAG_URL': JSON.stringify(process.env.DIAG_URL ?? '') } })
await bundle('sw.ts', 'sw.js', { format: 'iife', define: { GZIPPED: JSON.stringify(gzipped) } })
if (!isPublic) await bundle('client-tap.ts', 'client-tap.js', { target: 'node' })

for (const path of walk(out)) if (!kept.has(path)) rmSync(join(out, path))
const bytes = [...kept].reduce((sum, path) => sum + statSync(join(out, path)).size, 0)
console.log(`Built ${out}: ${kept.size} files, ${(bytes / 1e6).toFixed(1)} MB (${compressed} compressed now, ${reused} unchanged, ${copied} copied; ${gzipped.length} shipped as .gz)${isPublic ? `; public build${publicModel ? `, starting on ${publicModel}` : ''}` : ''}${modelUrl ? `; default model ${modelUrl}` : ''}${tunnelUrl ? `; default tunnel ${tunnelUrl}` : ''}${wispUrl ? `; default Wisp server ${wispUrl}` : ''}`)
