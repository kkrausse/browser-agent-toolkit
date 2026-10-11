#!/usr/bin/env bun
// Several result files of the memory driver side by side, one line per point.
//   bun bench/memory/compare.ts out/base-todo-reopen.json out/final-todo-reopen.json …
// MB, "median (min–max)" over a file's runs. Columns: the tab's process before the capture
// (PSS + swap), after the forced collection (Chrome only), the highest RSS + swap seen
// since the previous point, the kernel memory (committed, resident from smaps, and the
// kernel's own count of bytes in use and its peak), the image cache, and Chrome's
// partition_alloc mappings. WebKit files have the web process and, as "others", the sum of
// that browser's other processes.
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const mb = (kb: number) => kb / 1024
const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2 }
const range = (values: (number | undefined)[], digits = 0) => {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  if (!v.length) return '–'
  const f = (x: number) => x.toFixed(digits)
  return v.length === 1 || Math.min(...v) === Math.max(...v) ? f(median(v)) : `${f(median(v))} (${f(Math.min(...v))}–${f(Math.max(...v))})`
}
const row = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`
const head = ['file', 'point', 'n', 'PSS + swap', 'after GC', 'peak RSS since previous', 'kernel committed', 'kernel resident', 'kernel in use (peak)', 'image cache (loads, drops)', 'partition_alloc', 'others (WebKit)', 'load']
console.log(row(head)); console.log(row(head.map(() => '---')))
for (const file of process.argv.slice(2)) {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const runs: any[] = data.runs.filter((run: any) => run.points.length)
  const names: string[] = [...new Set(runs.flatMap((run) => run.points.map((p: any) => p.name)))]
  const wk = data.meta.browser?.startsWith('webkit')
  for (const name of names) {
    const points = runs.map((run) => run.points.find((p: any) => p.name === name)).filter(Boolean)
    const cost = (s: any) => (s?.pss === undefined ? undefined : mb(s.pss + s.swap))
    const kernel = (p: any) => {
      const bytes = p.browser.targets[0]?.memories?.find((m: any) => m.shared)?.bytes ?? p.browser.runtime?.kernel?.size
      const memories: any[] = p.pre.main.wasmMemories ?? []
      return bytes ? memories.find((m) => m.committedKb * 1024 === bytes) ?? { committedKb: bytes / 1024 } : memories[0]
    }
    const rt = (p: any) => p.browser.runtime
    console.log(row([basename(file, '.json'), name, points.length,
      range(points.map((p) => cost(p.pre.main))),
      wk || data.meta.queryObjects === false ? '–' : range(points.map((p) => cost(p.post.main))),
      range(points.map((p) => mb(Math.max(p.peakSincePreviousPoint.rss, p.pre.main.rss + p.pre.main.swap)))),
      range(points.map((p) => kernel(p) && mb(kernel(p).committedKb))),
      range(points.map((p) => (kernel(p)?.rssKb === undefined ? undefined : mb(kernel(p).rssKb + (kernel(p).swapKb ?? 0)))), 1),
      points.some(rt) ? `${range(points.map((p) => rt(p)?.kernel.inUse / 2 ** 20))} (${range(points.map((p) => rt(p)?.kernel.peakInUse / 2 ** 20))})` : '–',
      points.some(rt) ? `${range(points.map((p) => rt(p)?.imageCache.bytes / 2 ** 20))} (${range(points.map((p) => rt(p)?.imageCache.loads))}, ${range(points.map((p) => rt(p)?.imageCache.evictions))})` : '–',
      wk ? '–' : range(points.map((p) => { const r = p.pre.main.regions?.['[anon:partition_alloc]']; return r ? mb(r.pss + r.swap) : undefined })),
      wk ? range(points.map((p) => (p.pre.others ?? []).reduce((sum: number, o: any) => sum + mb((o.pss ?? 0) + (o.swap ?? 0)), 0))) : '–',
      `${Math.min(...points.map((p) => p.pre.load[0])).toFixed(1)}–${Math.max(...points.map((p) => p.pre.load[0])).toFixed(1)}`]))
  }
  const hwm = range(runs.map((run) => mb(Math.max(...run.points.map((p: any) => p.post.main.hwm ?? 0)))))
  console.log(row([basename(file, '.json'), 'whole run', runs.length, `VmHWM ${hwm}`, '', '', '', '', '', '', '', '', `open ${range(runs.map((run) => run.open?.openMs))} ms, turn 1 ${range(runs.map((run) => run.turn1?.replyMs))} ms, turns ${range(runs.map((run) => run.turns?.reduce((sum: number, t: any) => sum + t.replyMs, 0)))} ms${data.runs.some((run: any) => run.error) ? `; ${data.runs.filter((run: any) => run.error).length} failed` : ''}`]))
}
