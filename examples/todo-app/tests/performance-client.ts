import { clearWorkspace, diagnoseWorkspace } from "@kev-browser-agent-kit/workspace"
import { experimentalSourceReplacementTool, installSource } from "@kev-browser-agent-kit/workspace/delivery"
import type { SourceDelivery } from "@kev-browser-agent-kit/workspace/delivery"
import { WorkspaceController } from "@kev-browser-agent-kit/workspace/react"
import { installOpenCodeConfig, loadPrepared, preparedApps, startOpenCode } from "@kev-browser-agent-kit/opencode-chat/browser"
import { createDiagnosticScope } from '@kev-browser-agent-kit/workspace/diagnostics'

type Variant = "baseline" | "kernel" | "dependencies" | "incremental" | "reload"
type Sample = { name: string; milliseconds: number; detail?: unknown }
const samples: Sample[] = []
const events: unknown[] = []
const parameters = new URLSearchParams(location.search)
const candidate = parameters.get("candidate") ?? "baseline"
const variant = (parameters.get("variant") ?? "baseline") as Variant
if (!["baseline", "kernel", "dependencies", "incremental", "reload"].includes(variant)) throw new Error("Unknown experiment variant")
const controller = new WorkspaceController({ onDiagnostic: event => events.push(event) })
const output = document.querySelector("pre")!
const write = (): void => { output.textContent = JSON.stringify({ variant, candidate, samples }, null, 2) }
async function timed<T>(name: string, task: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try { return await task() } finally { samples.push({ name, milliseconds: performance.now() - started }); write() }
}
const manifest = await timed("manifest", () => loadPrepared(`/prepared/${candidate}/`, controller.signal))
const fixture = (generation: number): SourceDelivery => {
  const home = manifest.project['/src/home.tsx']
  const config = manifest.project['/vite.config.ts']
  if (typeof home !== 'string' || typeof config !== 'string') throw new Error('Expected todo source/config fixture')
  return {...manifest.project,
    '/src/home.tsx': "import {runPdfWorkload} from './pdf-workload'\n" + home.replace("import { useState }", "import { useEffect, useState }").replace('export default function Home() {', `export default function Home() { useEffect(() => { document.querySelector('main')?.setAttribute('data-hydrated', '${generation}'); }, []);`).replace('<h1>Todos</h1>', `<h1 data-generation="${generation}">Todos ${generation}</h1><button type="button" id="pdf-workload" onClick={async (event) => {const button = event.currentTarget; button.dataset.bytes = String(await runPdfWorkload());}}>Generate fixture PDF</button>`),
    '/src/pdf-workload.ts': `import {PDFDocument} from 'pdf-lib'; export async function runPdfWorkload() {const pdf = await PDFDocument.create(); pdf.addPage().drawText('Todo dependency workload'); return (await pdf.save()).length;}`,
    '/vite.config.ts': config.replace('defineConfig({', `defineConfig({ cacheDir: '/workspace/.browser-editor-cache/vite',`),
    '/binary.dat': {encoding: 'base64', data: 'AAEC/w=='},
  }
}
const distribution = { name: "vivari", version: manifest.runtimeVersion, assetBaseUrl: "/runtime/" }
const canReuse = ["dependencies", "incremental", "reload"].includes(variant)
let generation = 1
let switching = false
const diagnostics = createDiagnosticScope(event => {events.push(event); if (event.event === 'delivery.installed-environment') samples.push({name: event.event, milliseconds: 0, detail: event.data})})
async function runtime(generation = 1): Promise<void> {
  const apps = preparedApps(manifest, `/prepared/${candidate}/`, controller.signal, text => console.info(text), diagnostics, {experimentalReuseInstalled: canReuse})
  const instance = await timed("runtime.start", () => controller.startRuntime({ apps, replaceSource: experimentalSourceReplacementTool(fixture(generation), {incremental: variant === 'incremental'}) }))
  await timed("environment.deliver", () => instance.tools.apps())
  await timed("environment.flush", () => controller.workspace!.flush())
}
async function replacement(generation: number): Promise<void> {
  const instance = controller.runtime as Awaited<ReturnType<typeof controller.startRuntime<{apps: ReturnType<typeof preparedApps>; replaceSource: ReturnType<typeof experimentalSourceReplacementTool>}>>>
  const result = await instance.tools.replaceSource()
  samples.push({ name: "source.operations", milliseconds: 0, detail: {generation, ...result} })
}
async function services(generation: number): Promise<void> {
  await timed("config", () => installOpenCodeConfig(controller.workspace!, {modelBaseURL: location.origin + "/unused-model/"}))
  await Promise.all([
    timed("preview.ready", async () => {
      const service = await controller.launch("vite", manifest.preview, 5173, async endpoint => ({url: endpoint.url, fetch: (input, init) => endpoint.fetch(String(input), init)}))
      const response = await service.endpoint.fetch("/", {signal: AbortSignal.timeout(60000)})
      if (!response.ok) throw new Error(`Preview HTTP ${response.status}`)
      const iframe = document.querySelector("iframe")!
      const attachment = service.endpoint.attachPreview(iframe, {hostPaths: ['/api', '/editing-policy']})
      controller.registerAttachment('vite', () => attachment.dispose())
      const deadline = performance.now() + 90000
      while (performance.now() < deadline) {
        if (iframe.contentDocument?.querySelector(`main[data-hydrated="${generation}"] h1[data-generation="${generation}"]`) && iframe.contentDocument.querySelector('input#title:not(:disabled)')) { controller.clientReady("vite"); return }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error(`Fresh preview generation ${generation} never appeared`)
    }),
    timed("chat.healthy", async () => {
      await startOpenCode(controller, {prepared: manifest, waitForClient: false})
    }),
  ])
}
async function start(): Promise<void> {
  await timed("workspace.open", () => controller.open(distribution))
  // Reload intentionally preserves source and the installed receipt.
  if (variant !== "reload") await timed("workspace.clear", () => clearWorkspace(controller.workspace!))
  await timed("source.install", () => installSource(controller.workspace!, fixture(1), {existing: "replace"}))
  await runtime()
  await services(1)
  await controller.workspace!.flush()
}
async function switchWorkspace(): Promise<void> {
  if (switching) throw new Error('An experiment switch is already running')
  switching = true
  const nextGeneration = generation + 1
  try {
  await timed("switch.total", async () => {
    await timed("runtime.stop", () => controller.stopRuntime())
    if (variant === "baseline" || variant === "kernel") {
      await timed("workspace.clear", () => clearWorkspace(controller.workspace!))
      if (variant === "baseline") {
        await timed("workspace.close", () => controller.close())
        await timed("workspace.open", () => controller.open(distribution))
      }
      await timed("source.install", () => installSource(controller.workspace!, fixture(nextGeneration), {existing: "replace"}))
      await runtime(nextGeneration)
    } else {
      // Runtime wrapper is cheap; all previous executions were stopped above.
      await runtime(nextGeneration)
      await timed("source.replace", () => replacement(nextGeneration))
    }
    await services(nextGeneration)
    await timed("switch.flush", () => controller.workspace!.flush())
  })
  generation = nextGeneration
  } catch (error) {
    api.error = String(error)
    api.ready = false
    write()
    throw error
  } finally { switching = false }
}
async function verifySource(): Promise<{files: number; generation: number}> {
  let files = 0
  for (const [path, file] of Object.entries(fixture(generation))) {
    const expected = typeof file === 'string' ? new TextEncoder().encode(file) : Uint8Array.from(atob(file.data), character => character.charCodeAt(0))
    const actual = await controller.workspace!.fs.readFile(path)
    if (actual.length !== expected.length || actual.some((byte, index) => byte !== expected[index])) throw new Error(`Target source mismatch: ${path}`)
    files++
  }
  return {files, generation}
}
const api = { samples, events, ready: false, error: "", switchWorkspace, verifySource, diagnostics: () => diagnoseWorkspace(controller.workspace!), stop: () => controller.close(), resources: () => performance.getEntriesByType("resource").map(entry => {
  const resource = entry as PerformanceResourceTiming
  return { name: resource.name, transferSize: resource.transferSize, encodedBodySize: resource.encodedBodySize, duration: resource.duration }
}) }
Object.assign(window, { editorPerformanceExperiment: api })
try {
  await timed("startup.total", start)
  api.ready = true
  document.querySelector("button")!.addEventListener("click", () => { void switchWorkspace().catch(error => { api.error = String(error); write() }) })
} catch (error) {
  api.error = String(error)
  output.textContent += "\n" + api.error
  console.error(error)
}
