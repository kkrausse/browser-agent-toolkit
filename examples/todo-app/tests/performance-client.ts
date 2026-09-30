import { clearWorkspace, diagnoseWorkspace, diagnoseWorkspaceEntry } from "@kev-browser-agent-kit/workspace"
import { experimentalSourceReplacementTool, installSource } from "@kev-browser-agent-kit/workspace/delivery"
import type { SourceDelivery } from "@kev-browser-agent-kit/workspace/delivery"
import { WorkspaceController } from "@kev-browser-agent-kit/workspace/react"
import { installOpenCodeConfig, loadPrepared, preparedApps, startOpenCode } from "@kev-browser-agent-kit/opencode-chat/browser"
import { createDiagnosticScope } from '@kev-browser-agent-kit/workspace/diagnostics'
import { installedTreeAuditTool } from './installed-tree-audit'
import { boundedReadiness, matchedReadinessBudgets } from './matched-readiness'

type Variant = "baseline" | "kernel" | "dependencies" | "incremental" | "reload"
type Sample = { name: string; milliseconds: number; detail?: unknown }
const samples: Sample[] = []
const events: unknown[] = []
const resetEvidence: unknown[] = []
const parameters = new URLSearchParams(location.search)
const candidate = parameters.get("candidate") ?? "baseline"
const variant = (parameters.get("variant") ?? "baseline") as Variant
const captureResetEvidence = parameters.get('fsEvidence') === '1'
const installOnly = parameters.get('services') === 'none'
const matched = parameters.get('matched') === 'phase9'
const readinessBudgets = matchedReadinessBudgets(parameters)
if (matched && !['baseline', 'dependencies'].includes(variant)) throw Error('Phase9 requires restarted services')
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
    '/src/home.tsx': (matched ? "import {workspace} from './switch-import'\n" : '') + "import {runPdfWorkload} from './pdf-workload'\n" + home.replace("import { useState }", "import { useEffect, useState }").replace('export default function Home() {', `export default function Home() { useEffect(() => { document.querySelector('main')?.setAttribute('data-hydrated', '${generation}'); }, []);`).replace('<h1>Todos</h1>', `<h1 ${matched ? 'data-workspace={workspace}' : ''} data-generation="${generation}">Todos ${generation}</h1><button type="button" id="pdf-workload" onClick={async (event) => {const button = event.currentTarget; button.dataset.bytes = String(await runPdfWorkload());}}>Generate fixture PDF</button>`),
    '/src/pdf-workload.ts': `import {PDFDocument} from 'pdf-lib'; export async function runPdfWorkload() {const pdf = await PDFDocument.create(); pdf.addPage().drawText('Todo dependency workload'); return (await pdf.save()).length;}`,
    '/vite.config.ts': config.replace('defineConfig({', `defineConfig({ cacheDir: '/workspace/.browser-editor-cache/vite',`),
    '/binary.dat': {encoding: 'base64', data: 'AAEC/w=='},
    [generation % 2 ? '/switch-a-only.ts' : '/switch-b-only.ts']: `export const workspace = '${generation % 2 ? 'A' : 'B'}';`,
    ...(matched ? {'/src/switch-import.ts': `export {workspace} from '../switch-${generation % 2 ? 'a' : 'b'}-only'`} : {}),
  }
}
// Read-only, bounded evidence. Only recurse into manifest-declared directories:
// public stat follows symlinks, so never use it to choose traversal targets.
async function remainingTree(root = '/node_modules'): Promise<unknown> {
  const started = performance.now()
  const known = new Map(manifest.assets.filter(entry => entry.destination.startsWith('/workspace/')).map(entry => [entry.destination.slice('/workspace'.length), entry]))
  const directories: unknown[] = []
  const pending = [root]
  let entries = 0
  while (pending.length && directories.length < 500 && entries < 20000 && performance.now() - started < 10000) {
    const path = pending.shift()!
    try {
      const names = await controller.workspace!.fs.readdir(path)
      const children = names.map(name => {
        const child = path + '/' + name
        const entry = known.get(child)
        if (entry?.kind === 'directory') pending.push(child)
        return {name, kind: entry?.kind ?? 'unknown', ...(entry?.kind === 'symlink' ? {target: entry.target} : {})}
      })
      entries += names.length
      directories.push({path, children})
    } catch (error) { directories.push({path, error: String(error)}) }
  }
  return {root, milliseconds: performance.now() - started, entries, directories, truncated: pending.length > 0, pending}
}
async function observedClear(attemptedGeneration = generation + 1): Promise<void> {
  try { await timed('workspace.clear', () => clearWorkspace(controller.workspace!)) }
  catch (error) {
    if (captureResetEvidence) {
      try {
        const evidence = {phase: 'clear.failed', generation, attemptedGeneration, error: String(error),
          stack: error instanceof Error ? error.stack : undefined, processes: await diagnoseWorkspace(controller.workspace!),
          rootEntries: await controller.workspace!.fs.readdir('/'), frontier: await deletionFrontier(), remaining: await remainingTree()}
        resetEvidence.push(evidence)
        await new Promise(resolve => setTimeout(resolve, 250))
        resetEvidence.push({phase: 'clear.failed.delayed', processes: await diagnoseWorkspace(controller.workspace!), remaining: await remainingTree()})
      } catch (evidenceError) { resetEvidence.push({phase: 'evidence.failed', error: String(evidenceError), originalError: String(error)}) }
    }
    throw error
  }
}
async function deletionFrontier(): Promise<unknown[]> {
  const observations: unknown[] = []
  let path = '/node_modules'
  for (let depth = 0; depth < 24; depth++) {
    try {
      const entry = await diagnoseWorkspaceEntry(controller.workspace!, path)
      observations.push(entry)
      if (entry.metadata.kind !== 'dir' || !entry.names?.length) break
      path += '/' + entry.names[0]
    } catch (error) { observations.push({path, error: String(error)}); break }
  }
  return observations
}
const distribution = { name: "vivari", version: manifest.runtimeVersion, assetBaseUrl: "/runtime/" }
const canReuse = ["dependencies", "incremental", "reload"].includes(variant)
let generation = 1
let switching = false
const diagnostics = createDiagnosticScope(event => {events.push(event); if (event.event === 'delivery.installed-environment') samples.push({name: event.event, milliseconds: 0, detail: event.data})})
async function runtime(generation = 1): Promise<void> {
  const apps = preparedApps(manifest, `/prepared/${candidate}/`, controller.signal, text => console.info(text), diagnostics, {experimentalReuseInstalled: canReuse && !matched})
  const instance = await timed("runtime.start", () => controller.startRuntime({ apps, audit: installedTreeAuditTool(manifest.assets), replaceSource: experimentalSourceReplacementTool(fixture(generation), {incremental: variant === 'incremental'}) }))
  if (!matched || generation === 1 || variant === 'baseline') await timed("environment.deliver", () => instance.tools.apps())
  await timed("environment.flush", () => controller.workspace!.flush())
}
async function replacement(generation: number): Promise<void> {
  const instance = controller.runtime as Awaited<ReturnType<typeof controller.startRuntime<{apps: ReturnType<typeof preparedApps>; replaceSource: ReturnType<typeof experimentalSourceReplacementTool>}>>>
  const result = await instance.tools.replaceSource()
  samples.push({ name: "source.operations", milliseconds: 0, detail: {generation, ...result} })
}
async function services(generation: number): Promise<void> {
  if (matched) {
    resetEvidence.push({phase:'readiness.budgets',generation,budgets:readinessBudgets})
    return boundedReadiness(readinessBudgets.overallMs, controller.signal, signal => startServices(generation, signal))
  }
  return startServices(generation, controller.signal)
}
async function startServices(generation: number, signal: AbortSignal): Promise<void> {
  const readiness = matched ? {...readinessBudgets, signal} : undefined
  await timed("config", () => installOpenCodeConfig(controller.workspace!, {modelBaseURL: location.origin + "/unused-model/"}))
  await Promise.all([
    timed("preview.ready", async () => {
      const service = await timed('vite.launch', () => controller.launch("vite", manifest.preview, 5173, async endpoint => ({url: endpoint.url, fetch: (input, init) => endpoint.fetch(String(input), init)}), undefined, readiness))
      const earlyExit = service.execution.exited.then(exit => {throw Error('Vite exited before interactive readiness: ' + JSON.stringify(exit))})
      const outputFailure = service.drained.then(() => new Promise<never>(() => {}))
      void earlyExit.catch(() => {}); void outputFailure.catch(() => {})
      const previewTask = async (previewSignal: AbortSignal) => {
        const response = await service.endpoint.fetch("/", {signal: AbortSignal.any([previewSignal, AbortSignal.timeout(60000)])})
        if (!response.ok) throw new Error(`Preview HTTP ${response.status}`)
        await response.arrayBuffer()
        const iframe = document.querySelector("iframe")!
        const attachment = service.endpoint.attachPreview(iframe, {hostPaths: ['/api', '/editing-policy']})
        controller.registerAttachment('vite', () => attachment.dispose())
        const deadline = performance.now() + (matched ? readinessBudgets.hydrationMs : 90000)
        while (performance.now() < deadline) {
          previewSignal.throwIfAborted()
          if (iframe.contentDocument?.querySelector(`main[data-hydrated="${generation}"] h1[data-generation="${generation}"]`) && iframe.contentDocument.querySelector('input#title:not(:disabled)')) { controller.clientReady("vite"); return }
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        throw new Error(`Fresh preview generation ${generation} never appeared`)
      }
      await Promise.race([earlyExit, outputFailure, matched ? boundedReadiness(readinessBudgets.hydrationMs, signal, previewTask) : previewTask(signal)])
    }),
    timed("chat.healthy", async () => {
      await startOpenCode(controller, {prepared: manifest, waitForClient: false, readiness})
    }),
  ])
}
async function start(): Promise<void> {
  await timed("workspace.open", () => controller.open(distribution))
  // Reload intentionally preserves source and the installed receipt.
  if (variant !== "reload") await observedClear(1)
  await timed("source.install", () => installSource(controller.workspace!, fixture(1), {existing: "replace"}))
  await runtime()
  if (matched) await audit('initial')
   if (!installOnly) await timed('services.wall', () => services(1))
  await controller.workspace!.flush()
}
async function switchWorkspace(): Promise<void> {
  if (switching) throw new Error('An experiment switch is already running')
  if (matched && (api.error || generation >= 6)) throw Error('Phase9 stopped or fixed budget exhausted')
  switching = true
  const nextGeneration = generation + 1
  try {
  await timed("switch.total", async () => {
    const ownedServices = Object.entries(controller.getSnapshot().services)
    if (captureResetEvidence) resetEvidence.push({phase: 'before.stop', generation, processes: await diagnoseWorkspace(controller.workspace!)})
     await timed("runtime.stop", async () => {
       await controller.stopRuntime()
       if (matched) await Promise.all(ownedServices.map(async ([, service]) => {await service.execution.exited; await service.drained}))
     })
    if (captureResetEvidence) resetEvidence.push({phase: 'after.stop', generation, processes: await diagnoseWorkspace(controller.workspace!),
      services: await Promise.all(ownedServices.map(async ([name, service]) => ({name, exit: await service.execution.exited, drained: await service.drained.then(() => true)})))})
    if (matched) {
      await Promise.all(ownedServices.map(async ([, service]) => {await service.execution.exited; await service.drained}))
      const stopped = await diagnoseWorkspace(controller.workspace!)
      resetEvidence.push({phase:'phase9.stopped', generation, stopped})
      assertStopped(stopped)
    }
    if (variant === "baseline" || variant === "kernel") {
      await observedClear()
      if (variant === "baseline") {
        await timed("workspace.close", () => controller.close())
        await timed("workspace.open", () => controller.open(distribution))
      }
      await timed("source.install", () => installSource(controller.workspace!, fixture(nextGeneration), {existing: "replace"}))
      await runtime(nextGeneration)
    } else {
      // Runtime wrapper is cheap; all previous executions were stopped above.
      await runtime(nextGeneration)
      if (matched) {
        // In this fixed fixture, dependency and configuration inputs must not vary
        // across generations. Source receipts alone are not an installed-tree proof.
        const compatible = await timed('validation.compatibility', async () => {
          if (manifest.dependencies.policy.runtimeVersion !== distribution.version) return false
          for (const path of ['/package.json', '/bun.lock', '/vite.config.ts', '/react-router.config.ts', '/tsconfig.json']) {
            const wanted = fixture(nextGeneration)[path]
            if (typeof wanted !== 'string') return false
            const actual = new TextDecoder().decode(await controller.workspace!.fs.readFile(path))
            if (actual !== wanted) return false
          }
          return true
        }).catch(() => false)
        const valid = await audit('before-retain')
        if (!valid || !compatible) await fullResetFallback(nextGeneration)
      }
      await timed("source.replace", () => replacement(nextGeneration))
      if (matched) await audit('after-replacement')
    }
     if (!installOnly) await timed('services.wall', () => services(nextGeneration))
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
function assertStopped(value: unknown): void {
  // Keep exact shape handling fail-closed; a missing diagnostic field is not zero.
  const d = value as Record<string, any>
  if (!Array.isArray(d.procs) || d.procs.length || !Array.isArray(d.listeners) || d.listeners.length
    || d.pendingHttp !== 0 || d.fetch?.inflight !== 0 || d.fetch?.queued !== 0 || d.fetch?.active !== 0) throw Error('Stopped kernel diagnostics incomplete/nonzero: ' + JSON.stringify(d))
}
let retainedCacheDigest: string | undefined
async function audit(phase: string): Promise<boolean> {
  const runtime = controller.runtime as Awaited<ReturnType<typeof controller.startRuntime<{audit: ReturnType<typeof installedTreeAuditTool>}>>>
  const result = await timed('validation.' + phase, () => runtime.tools.audit()).catch(error => {
    if (phase !== 'before-retain') throw error
    return {valid:false,checked:0,reason:String(error),cacheDigest:undefined}
  })
  resetEvidence.push({phase:'phase9.audit', point:phase,generation,result})
  if (phase === 'before-retain') retainedCacheDigest = result.cacheDigest
  if (phase === 'after-replacement' && result.cacheDigest !== retainedCacheDigest) throw Error('Cache bytes changed during source replacement')
  if (!result.valid && phase === 'after-replacement') await fullResetFallback(generation + 1)
  if (!result.valid && phase !== 'before-retain') throw Error('Installed tree audit failed: ' + result.reason)
  return result.valid
}
async function fullResetFallback(nextGeneration: number): Promise<never> {
  await timed('fallback.full-reset', async () => {
    await controller.stopRuntime()
    assertStopped(await diagnoseWorkspace(controller.workspace!))
    await observedClear()
    await controller.close()
    await controller.open(distribution)
    await installSource(controller.workspace!, fixture(nextGeneration), {existing:'replace'})
    const apps = preparedApps(manifest, `/prepared/${candidate}/`, controller.signal, text => console.info(text), diagnostics)
    const fresh = await controller.startRuntime({apps})
    await fresh.tools.apps()
    await controller.workspace!.flush()
  })
  resetEvidence.push({phase:'phase9.full-reset-fallback',generation:nextGeneration})
  // Mandatory recovery is not a matched reuse pass; never launch incoming services.
  throw Error('Installed tree/input untrusted: full reset fallback completed; cohort stopped')
}
async function verifySource(): Promise<{files: number; generation: number}> {
  let files = 0
  for (const [path, file] of Object.entries(fixture(generation))) {
    const expected = typeof file === 'string' ? new TextEncoder().encode(file) : Uint8Array.from(atob(file.data), character => character.charCodeAt(0))
    const actual = await controller.workspace!.fs.readFile(path)
    if (actual.length !== expected.length || actual.some((byte, index) => byte !== expected[index])) throw new Error(`Target source mismatch: ${path}`)
    files++
  }
  const removed = generation % 2 ? '/switch-b-only.ts' : '/switch-a-only.ts'
  if ((await controller.workspace!.fs.readdir('/')).includes(removed.slice(1))) throw new Error(`Outgoing workspace file retained: ${removed}`)
  return {files, generation}
}
const api = { samples, events, resetEvidence, installOnly, ready: false, error: "", switchWorkspace, verifySource, remainingTree,
  filesystemSymlinkControl: async () => {
    if (!installOnly || switching || api.error || !controller.runtime) throw new Error('Symlink controls require a healthy install-only cohort')
    switching = true
    const root = '/reset-symlink-control'
    const target = '/reset-symlink-target'
    const script = '/reset-symlink-control.js'
    try {
      await controller.workspace!.fs.writeFile(script, `const fs = require('fs'); fs.mkdirSync('/workspace${root}'); fs.mkdirSync('/workspace${target}'); fs.writeFileSync('/workspace${target}/sentinel', 'outside target'); fs.symlinkSync('../reset-symlink-target', '/workspace${root}/directory-link'); fs.symlinkSync('../reset-symlink-absent', '/workspace${root}/dangling-link');`)
      const execution = await controller.runtime.node({entry: '/workspace' + script, cwd: '/workspace', signal: AbortSignal.timeout(30000)})
      const drain = async (stream: AsyncIterable<Uint8Array>): Promise<string> => { const decoder = new TextDecoder(); let output = ''; for await (const bytes of stream) output += decoder.decode(bytes, {stream: true}); return output + decoder.decode() }
      const drained = Promise.all([drain(execution.stdout), drain(execution.stderr)])
      execution.closeStdin()
      const exit = await execution.exited
      const output = await drained
      if (exit.exitCode !== 0) throw new Error(`Symlink fixture exited ${exit.exitCode}: ${output[1]}`)
      const before = await Promise.all(['directory-link', 'dangling-link'].map(name => diagnoseWorkspaceEntry(controller.workspace!, root + '/' + name)))
      await controller.stopRuntime()
      const processes = await diagnoseWorkspace(controller.workspace!)
      await controller.workspace!.fs.remove(root)
      const after = await diagnoseWorkspaceEntry(controller.workspace!, root).catch(error => ({error: String(error)}))
      const sentinel = new TextDecoder().decode(await controller.workspace!.fs.readFile(target + '/sentinel'))
      if (sentinel !== 'outside target' || !('error' in after) || !after.error.includes('ENOENT')) throw new Error('Symlink removal contract failed')
      await controller.workspace!.fs.remove(target)
      await controller.workspace!.fs.remove(script)
      const result = {root, before, after, sentinel, exit, processes}
      resetEvidence.push({phase: 'filesystem.symlink-control', ...result})
      return result
    } finally { switching = false }
  },
  inspectEntry: async (path: string) => {
    const entry = await diagnoseWorkspaceEntry(controller.workspace!, path)
    if (entry.metadata.kind !== 'file') return entry
    const bytes = await controller.workspace!.fs.readFile(path)
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
    return {...entry, bytes: bytes.length, sha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}
  },
  filesystemControl: async (newline: boolean) => {
    if (!installOnly || switching || api.error) throw new Error('Filesystem controls require a healthy install-only cohort')
    switching = true
    const root = newline ? '/reset-newline-control' : '/reset-plain-control'
    const path = root + (newline ? '/line\nbreak.txt' : '/plain.txt')
    try {
      await controller.stopRuntime()
      await controller.workspace!.fs.mkdir(root)
      await controller.workspace!.fs.writeFile(path, 'control bytes')
      const before = await diagnoseWorkspaceEntry(controller.workspace!, path)
      let error: string | undefined
      try { await controller.workspace!.fs.remove(root) } catch (failure) { error = String(failure) }
      const result = {root, path, before, error, processes: await diagnoseWorkspace(controller.workspace!),
        after: await diagnoseWorkspaceEntry(controller.workspace!, path).catch(failure => ({error: String(failure)}))}
      resetEvidence.push({phase: 'filesystem.control', ...result})
      if (error) { api.error = error; api.ready = false }
      return result
    } finally { switching = false }
  },
  diagnostics: () => diagnoseWorkspace(controller.workspace!), stop: () => controller.close(), resources: () => performance.getEntriesByType("resource").map(entry => {
  const resource = entry as PerformanceResourceTiming
  return { name: resource.name, transferSize: resource.transferSize, encodedBodySize: resource.encodedBodySize, duration: resource.duration }
}) }
Object.assign(window, { editorPerformanceExperiment: api })
try {
  await timed("startup.total", start)
  api.ready = true
  if (!matched) document.querySelector("button")!.addEventListener("click", () => { void switchWorkspace().catch(error => { api.error = String(error); write() }) })
} catch (error) {
  api.error = String(error)
  output.textContent += "\n" + api.error
  console.error(error)
}
