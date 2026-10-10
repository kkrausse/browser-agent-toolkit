#!/usr/bin/env bun
// Summarise a V8 .cpuprofile: self time by function, and inclusive time by a chosen set of
// name patterns, optionally inside a time window.
//   bun bench/startup/profile-summary.ts <file.cpuprofile> [--from ms] [--to ms] [--top 40] [--by url|function]
const file = process.argv[2]
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? fallback : process.argv[i + 1]
}
const p = JSON.parse(await Bun.file(file).text())
const from = Number(arg('from', '0')) * 1000
const to = Number(arg('to', '1e12')) * 1000
const top = Number(arg('top', '40'))
const by = arg('by', 'function')
const nodes = new Map<number, any>(p.nodes.map((n: any) => [n.id, n]))
const parent = new Map<number, number>()
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const self = new Map<string, number>()
const incl = new Map<string, number>()
let t = 0
let total = 0
const short = (url: string) => url.replace(/^file:\/\//, '').replace(/.*node_modules\/\.bun\/[^/]+\/node_modules\//, '').replace(/^\/workspace\//, '')
const key = (n: any) => {
  const f = n.callFrame
  if (by === 'url') return f.url ? short(f.url).split('/').slice(0, f.url.includes('node_modules') ? (short(f.url).startsWith('@') ? 2 : 1) : 3).join('/') : f.functionName
  return `${f.functionName || '(anonymous)'} ${short(f.url)}:${f.lineNumber + 1}`
}
for (let i = 0; i < p.samples.length; i++) {
  const dt = p.timeDeltas[i]
  t += dt
  if (t < from || t > to) continue
  total += dt
  const n = nodes.get(p.samples[i])
  self.set(key(n), (self.get(key(n)) ?? 0) + dt)
  const seen = new Set<string>()
  for (let id: number | undefined = n.id; id !== undefined; id = parent.get(id)) {
    const k = key(nodes.get(id))
    if (!seen.has(k)) {
      seen.add(k)
      incl.set(k, (incl.get(k) ?? 0) + dt)
    }
  }
}
const show = (m: Map<string, number>, title: string) => {
  console.log(`\n${title}`)
  for (const [k, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${(v / 1000).toFixed(1).padStart(8)} ms  ${k.slice(0, 150)}`)
}
console.log(`window ${(total / 1000).toFixed(0)} ms of ${((p.endTime - p.startTime) / 1000).toFixed(0)} ms`)
show(self, 'self')
show(incl, 'inclusive')
