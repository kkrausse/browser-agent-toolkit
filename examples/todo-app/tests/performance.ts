import { join, resolve } from "node:path"
import { mkdir } from "node:fs/promises"
import { bundleEntries, bundleVfsImage } from "@kev-browser-agent-kit/workspace/prepare"
import type { ManagedEntry } from "@kev-browser-agent-kit/workspace/delivery"
import type { PreparedManifest } from "@kev-browser-agent-kit/opencode-chat/browser"
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { appRouter } from '../src/server/trpcRouter'
import type { Todo } from '../src/schema/todo'

// Standalone benchmark origin: no app auth, secrets, saved workspace APIs or model calls.
// Never bind publicly; never point it at a live application's origin/store.
const input = resolve(process.env.EDITOR_PERFORMANCE_INPUT ?? ".editor/prepared")
const runtime = resolve(process.env.RUNTIME_DIR ?? "../../workspace-api/dist/runtime")
const output = resolve(".editor/performance")
const manifest = await Bun.file(join(input, "manifest.json")).json() as PreparedManifest
await mkdir(output, {recursive: true})
const candidates = ["baseline", "maps", "maps-native"] as const
const summaries: unknown[] = []
for (const name of candidates) {
  let assets = manifest.assets.filter(entry => name === "baseline" || entry.kind !== "file" || !(
    entry.destination.endsWith(".map") ||
    (name.includes("native") && entry.destination.startsWith('/workspace/node_modules/') && /\.(node|dylib)$/.test(entry.destination))
  ))
  // Exclusion can leave dangling .bin/package symlinks: remove them to a fixed point.
  const original = new Map(manifest.assets.map(entry => [entry.destination, entry]))
  const targetFor = (path: string, visited = new Set<string>()): string => {
    const parts = path.split("/").slice(1)
    for (let index = 0; index < parts.length; index++) {
      const prefix = "/" + parts.slice(0, index + 1).join("/")
      const entry = original.get(prefix)
      if (entry?.kind !== "symlink") continue
      if (visited.has(prefix)) throw new Error(`Cyclic managed symlink: ${prefix}`)
      return targetFor(resolve(prefix, "..", entry.target, ...parts.slice(index + 1)), new Set([...visited, prefix]))
    }
    return path
  }
  let changed = name !== "baseline"
  while (changed) {
    const paths = new Set(assets.map(entry => entry.destination))
    const next: ManagedEntry[] = assets.filter(entry => entry.kind !== "symlink" || paths.has(targetFor(entry.destination)))
    changed = next.length !== assets.length
    assets = next
  }
  const directory = join(output, name)
  await mkdir(directory, {recursive: true})
  const bundle = name === "baseline" ? manifest.bundle! : await bundleEntries({entries: assets, assetDir: input, outputDir: directory})
  const image = name === "baseline" ? manifest.image! : await bundleVfsImage({entries: assets, assetDir: input, outputDir: directory})
  const candidate = {...manifest, assets, bundle, image}
  await Bun.write(join(directory, "manifest.json"), JSON.stringify(candidate))
  const unique = new Map(assets.flatMap(entry => entry.kind === "file" ? [[entry.file, entry.bytes] as const] : []))
  summaries.push({name, entries: assets.length, uniqueBytes: [...unique.values()].reduce((sum, bytes) => sum + bytes, 0), bundleBytes: bundle.bytes, imageBytes: image.bytes})
}
await Bun.write(join(output, "sizes.json"), JSON.stringify(summaries, null, 2))
console.log(JSON.stringify(summaries, null, 2))
if (process.argv.includes("--sizes-only")) process.exit(0)
async function buildClient(): Promise<void> {
const built = await Bun.build({entrypoints: ["tests/performance-client.ts"], target: "browser", outdir: join(output, "client"), minify: false,
  plugins: [{name: 'one-workspace-package', setup(build) {
    // Bun's copied peer dependencies can retain an older SDK. A single canonical
    // package instance is essential for Workspace's private ownership maps.
    build.onResolve({filter: /^@kev-browser-agent-kit\/workspace(?:\/(?:react|delivery|diagnostics))?$/}, args => ({path: resolve('../../workspace-api/dist/lib', (args.path.split('/')[2] ?? 'index') + '.js')}))
    build.onResolve({filter: /^@kev-browser-agent-kit\/opencode-chat\/browser$/}, () => ({path: resolve('../../opencode-chat/dist/browser.js')}))
  }}],
})
if (!built.success) throw new AggregateError(built.logs, "Benchmark client build failed")
}
await buildClient()
const html = '<!doctype html><html><head><title>Isolated todo editor performance experiment</title></head><body><h1>Todo editor performance experiment</h1><button>Switch fixture workspace</button><iframe style="width:100%;height:400px"></iframe><pre></pre><script type="module" src="/client/performance-client.js"></script></body></html>'
const todos = new Map<string, Todo>()
const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(process.env.EDITOR_PERFORMANCE_PORT ?? 43187),
  async fetch(request) {
    const path = new URL(request.url).pathname
    const headers = {"Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store", "Service-Worker-Allowed": "/"}
    if (path === "/") return new Response(html, {headers: {...headers, "Content-Type": "text/html"}})
    if (path.startsWith('/api/')) return fetchRequestHandler({endpoint: '/api', req: request, router: appRouter, createContext: ({req}) => ({req, todos})})
    if (path === '/editing-policy') return Response.json({allowed: false})
    const match = /^\/prepared\/(baseline|maps|maps-native)\/(.+)$/.exec(path)
    let filePath: string | undefined
    if (match) filePath = join(match[2] === "manifest.json" || match[1] !== "baseline" ? join(output, match[1]!) : input, match[2]!)
    else if (path.startsWith("/runtime/")) filePath = join(runtime, path.slice(9))
    else if (path === "/client/performance-client.js") { await buildClient(); filePath = join(output, "client/performance-client.js") }
    if (!filePath || path.split("/").some(part => part === "..") || !(await Bun.file(filePath).exists())) return new Response("Not found", {status: 404, headers})
    const file = Bun.file(filePath)
    return new Response(file, {headers: {...headers, "Content-Type": file.type}})
  },
})
console.log(`Isolated experiment: ${server.url}?variant=baseline&candidate=baseline`)
