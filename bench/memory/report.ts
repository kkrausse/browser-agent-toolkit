#!/usr/bin/env bun
// Tables from the memory driver's result files, as Markdown on stdout.
//   bun bench/memory/report.ts [bench/memory/out/todo-reopen.json …]     (default: every file in out/)
// Figures are MB (MiB), "median (min–max)" over the runs of a file.
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const dir = join(import.meta.dir, 'out')
const files = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(dir).filter((name) => name.endsWith('.json')).sort().map((name) => join(dir, name))
const mb = (kb: number) => kb / 1024
const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2 }
const range = (values: (number | undefined)[], digits = 0) => {
  const v = values.filter((x): x is number => typeof x === 'number' && !Number.isNaN(x))
  if (!v.length) return '–'
  const f = (x: number) => x.toFixed(digits)
  return v.length === 1 ? f(v[0]!) : `${f(median(v))} (${f(Math.min(...v))}–${f(Math.max(...v))})`
}
const row = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`
const table = (head: string[], rows: (string | number)[][]) => [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n')

/** What a process costs: proportional resident memory plus what it has in swap (this machine's swap was in use). */
const cost = (p: any) => (p?.pss === undefined ? undefined : mb(p.pss + p.swap))
const priv = (p: any) => (p?.privateDirty === undefined ? undefined : mb(p.privateDirty + p.swap))
const kernelOf = (point: any, side: 'pre' | 'post') => {
  const bytes = point.browser.targets[0]?.memories?.find((m: any) => m.shared)?.bytes
  const memories: any[] = point[side].main.wasmMemories ?? []
  // Without queryObjects (terminal example) the shared kernel memory is taken to be the largest one.
  return bytes ? memories.find((m) => m.committedKb * 1024 === bytes) ?? { committedKb: bytes / 1024 } : memories[0]
}
const role = (target: any) => {
  if (target.kind === 'page') return 'page (and preview frame)'
  if (target.url.endsWith('bat-kerneld.js')) return 'kerneld'
  if (target.url.endsWith('bat-netd.js')) return 'netd'
  const argv: string[] = target.identity?.argv ?? []
  if (argv.length <= 1) return 'process: spare (no program yet)'
  return `process: ${argv.slice(1, 3).map((a) => a.replace(/^.*node_modules\//, '')).join(' ')}`
}

for (const file of files) {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const runs: any[] = data.runs.filter((run: any) => run.points.length)
  const failed = data.runs.filter((run: any) => run.error)
  console.log(`\n## ${basename(file)}\n`)
  console.log(`${data.meta.example}, ${data.meta.kind}, ${data.runs.length} runs (${failed.length} failed${failed.length ? ': ' + failed.map((r: any) => `run ${r.index} after "${r.points.at(-1)?.name ?? 'start'}"`).join(', ') : ''}), ${data.meta.chrome}, ${data.meta.startedAt} → ${data.meta.finishedAt}, commit ${data.meta.git}.`)
  console.log(`Service worker: ${runs.map((run) => (run.swInMainRenderer ? 'in the tab’s renderer' : run.swPid ? 'own renderer' : 'not found')).join(', ')}. Renderer exited after the tab closed: ${runs.map((run) => run.processesGoneAfterClose?.main).join(', ')}.\n`)
  const names: string[] = [...new Set(runs.flatMap((run) => run.points.map((p: any) => p.name)))]
  const at = (name: string) => runs.map((run) => run.points.find((p: any) => p.name === name)).filter(Boolean)

  console.log('### Totals\n')
  console.log(table(
    ['point', 'n', 'renderer RSS', 'renderer PSS + swap', 'private dirty + swap', 'after forced GC: PSS + swap', 'peak RSS + swap since previous point', 'service-worker renderer PSS + swap', 'measureUserAgentSpecificMemory', 'workers', 'load (1 min)'],
    names.map((name) => {
      const points = at(name)
      return [name, points.length,
        range(points.map((p) => mb(p.pre.main.rss))), range(points.map((p) => cost(p.pre.main))), range(points.map((p) => priv(p.pre.main))),
        data.meta.queryObjects === false ? '–' : range(points.map((p) => cost(p.post.main))),
        range(points.map((p) => mb(Math.max(p.peakSincePreviousPoint.rss, p.pre.main.rss + p.pre.main.swap)))),
        range(points.map((p) => cost(p.pre.sw))),
        range(points.map((p) => (p.browser.userAgentSpecificMemory ? p.browser.userAgentSpecificMemory.bytes / 2 ** 20 : undefined))),
        range(points.map((p) => p.browser.targets.length - 1)),
        `${Math.min(...points.map((p) => p.pre.load[0])).toFixed(1)}–${Math.max(...points.map((p) => p.pre.load[0])).toFixed(1)}`]
    }),
  ))
  console.log(`\nHighest resident size any run's renderer reached (VmHWM): ${range(runs.map((run) => mb(Math.max(...run.points.map((p: any) => p.post.main.hwm ?? 0)))))} MB.`)

  console.log('\n### Where the renderer\'s memory is (smaps, resident + swap, "pre" samples)\n')
  const regionNames = [...new Set(runs.flatMap((run) => run.points.flatMap((p: any) => Object.keys(p.pre.main.regions ?? {}))))]
  const regionAt = (name: string, region: string) => at(name).map((p) => { const r = p.pre.main.regions?.[region]; return r ? mb(r.pss + r.swap) : 0 })
  const order = regionNames.map((region) => [region, median(regionAt(names.includes('idle') ? 'idle' : names.at(-1)!, region))] as const).sort((a, b) => b[1] - a[1]).filter(([, value]) => value >= 0.5).map(([region]) => region)
  console.log(table(['mapping (PSS + swap)', ...names], order.map((region) => [region, ...names.map((name) => range(regionAt(name, region)))])))

  console.log('\n### Wasm memories (from smaps: committed = `buffer.byteLength`, resident = pages touched)\n')
  console.log(table(['point', 'kernel shared memory: committed', 'resident', 'reserved', 'other Wasm memories: count', 'committed', 'resident'], names.map((name) => {
    const points = at(name)
    const kernels = points.map((p) => kernelOf(p, 'pre'))
    const others = points.map((p, i) => (p.pre.main.wasmMemories ?? []).filter((m: any) => m !== kernels[i]))
    return [name, range(kernels.map((k) => k && mb(k.committedKb)), 1), range(kernels.map((k) => k?.rssKb !== undefined ? mb(k.rssKb + (k.swapKb ?? 0)) : undefined), 1), range(kernels.map((k) => k?.reservedKb && k.reservedKb / 1024 / 1024), 0) + ' GiB',
      range(others.map((o) => o.length)), range(others.map((o) => mb(o.reduce((sum: number, m: any) => sum + m.committedKb, 0))), 1), range(others.map((o) => mb(o.reduce((sum: number, m: any) => sum + m.rssKb + m.swapKb, 0))), 1)]
  })))

  const detail = names.includes('idle') ? 'idle' : names.at(-1)!
  console.log(`\n### Per context at "${detail}" (CDP Runtime.getHeapUsage; Wasm memories and modules from Runtime.queryObjects)\n`)
  const roles = [...new Set(at(detail).flatMap((p) => p.browser.targets.map(role)))]
  console.log(table(['context', 'n', 'JS heap total', 'JS heap used', 'after forced GC: used', 'ArrayBuffer backing stores', 'own (unshared) Wasm memories: count', 'their bytes', 'Wasm modules reachable'], roles.map((name) => {
    const targets = at(detail).flatMap((p) => p.browser.targets.filter((t: any) => role(t) === name))
    const own = (t: any) => (t.memories ?? []).filter((m: any) => !m.shared)
    const M = 2 ** 20
    return [name, targets.length, range(targets.map((t) => t.heap?.totalSize / M), 1), range(targets.map((t) => t.heap?.usedSize / M), 1), range(targets.map((t) => t.heapAfterGc?.usedSize / M), 1), range(targets.map((t) => t.heap?.backingStorageSize / M), 1),
      range(targets.map((t) => (t.memories ? own(t).length : undefined))), range(targets.map((t) => (t.memories ? own(t).reduce((sum: number, m: any) => sum + m.bytes, 0) / M : undefined)), 1), range(targets.map((t) => t.modules?.length))]
  })))
  const uasm = at(detail).map((p) => p.browser.userAgentSpecificMemory).filter(Boolean)
  if (uasm.length) {
    console.log(`\n\`measureUserAgentSpecificMemory()\` at "${detail}", first run: total ${(uasm[0].bytes / 2 ** 20).toFixed(0)} MB = ${uasm[0].breakdown.sort((a: any, b: any) => b.bytes - a.bytes).map((b: any) => `${(b.bytes / 2 ** 20).toFixed(0)} ${b.attribution[0] ? b.attribution[0].url.replace(/^.*\//, '') || '/' : b.types.join('+') || 'unattributed'}`).join(' + ')}.`)
  }

  console.log('\n### Storage\n')
  console.log(table(['point', '`navigator.storage.estimate()` usage', 'OPFS files, summed sizes', 'files (locked)'], names.map((name) => {
    const points = at(name)
    const sum = (p: any, key: string) => Object.values(p.browser.opfs ?? {}).reduce((total: number, entry: any) => total + entry[key], 0)
    return [name, range(points.map((p) => p.browser.page.storage.usage / 2 ** 20)), range(points.map((p) => (p.browser.opfs ? sum(p, 'bytes') / 2 ** 20 : undefined))), `${range(points.map((p) => (p.browser.opfs ? sum(p, 'files') : undefined)))} (${range(points.map((p) => (p.browser.opfs ? sum(p, 'locked') : undefined)))})`]
  })))

  const idle = runs.filter((run) => run.light?.length)
  if (idle.length) {
    console.log('\n### Left alone after the turns (no capture, no forced collection in between)\n')
    const seconds: number[] = [...new Set(idle.flatMap((run) => run.light.map((l: any) => l.secondsIdle as number)))].sort((a, b) => a - b)
    const turns = (run: any) => run.points.find((p: any) => p.name === 'turns')
    console.log(table(['seconds idle', 'renderer PSS + swap', 'kernel shared memory committed', 'load'], [
      ['0 (after the "turns" capture)', range(idle.map((run) => cost(turns(run)?.post.main))), range(idle.map((run) => { const k = turns(run) && kernelOf(turns(run), 'post'); return k && mb(k.committedKb) }), 1), ''],
      ...seconds.map((s) => {
        const samples = idle.map((run) => run.light.find((l: any) => l.secondsIdle === s)).filter(Boolean)
        return [s, range(samples.map((l) => cost(l.main))), range(samples.map((l) => mb(l.wasmMemories?.[0]?.committedKb ?? 0)), 1), range(samples.map((l) => l.load[0]), 1)]
      }),
    ]))
  }
  if (runs.some((run) => run.open)) console.log(`\nOpen took ${range(runs.map((run) => run.open?.openMs))} ms; turn 1 ${range(runs.map((run) => run.turn1?.replyMs))} ms; heading after the turns: ${runs.map((run) => JSON.stringify(run.turns?.at(-1)?.heading ?? null)).join(', ')}.`)
  for (const run of data.runs) if (run.events?.length || run.error) console.log(`\nRun ${run.index}: ${[...(run.events ?? []), run.error ? `error: ${run.error.slice(0, 300)}` : ''].filter(Boolean).join('; ')}`)
  const errors = [...new Set(runs.flatMap((run) => run.points.flatMap((p: any) => p.browser.errors)))]
  if (errors.length) console.log(`\nCapture errors: ${errors.slice(0, 6).join('; ')}`)
}
