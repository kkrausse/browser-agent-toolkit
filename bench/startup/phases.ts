#!/usr/bin/env bun
// Start-up phases from the trace marks of a run.ts output taken with --trace: medians and ranges per
// phase, for comparing browsers or variants.   bun bench/startup/phases.ts out/<label>.json [variant]
const r = JSON.parse(await Bun.file(process.argv[2]).text())
const want = process.argv[3]
const rows: Record<string, number[]> = {}
const add = (k: string, v: number) => { if (Number.isFinite(v)) (rows[k] ??= []).push(v) }
for (const s of r.samples) {
  if (want && s.variant !== want) continue
  if (s.outcome !== 'ok') continue
  const t = s.trace as { src: string; name: string; ms: number; data?: any }[]
  const find = (f: (m: any) => boolean) => t.find(f)?.ms ?? NaN
  const agentPid = t.find((m) => m.name === 'listen 4096')?.data?.pid
  const prog = t.find((m) => m.name === 'worker.programs' && m.data?.names?.[0] === 'opencode-server')
  const progV = t.find((m) => m.name === 'worker.programs' && m.data?.names?.[0] === 'start-preview')
  const er = find((m) => m.name === 'entry-returned' && m.data?.pid === agentPid)
  const listen = find((m) => m.name === 'listen 4096')
  const hq = find((m) => m.name.startsWith('req GET /api/health'))
  const aq = find((m) => m.name.startsWith('req POST /api/plugin/await-activation'))
  const ar = find((m) => m.name.startsWith('res 204 /api/plugin/await-activation'))
  const st = s.steps
  add('boot (click→boot.done)', st.boot)
  add('vite program load', progV?.data?.ms)
  add('vite spawn→listening', st['preview.listening'] - st['preview.spawn'])
  add('vite listening→ready (first response)', st['preview.ready'] - st['preview.listening'])
  add('vite ready→visible', st['preview.visible'] - st['preview.ready'])
  add('oc program load', prog?.data?.ms)
  add('oc program loaded→entry-returned', er - (prog?.ms ?? NaN))
  add('oc entry-returned→listen', listen - er)
  add('oc listen→health req', hq - listen)
  add('oc health→activation req', aq - hq)
  add('oc await-activation', ar - aq)
  add('oc activated→agent.ready', st['agent.ready'] - st['agent.activated'])
  add('oc agent.ready→chat.ready', st['chat.ready'] - st['agent.ready'])
  add('oc spawn→listening', st['agent.listening'] - st['agent.spawn'])
  add('oc listening→ready', st['agent.ready'] - st['agent.listening'])
  add('whole', Math.max(st['preview.visible'], st['chat.ready']))
  add('load1', s.load[0])
}
for (const [k, v] of Object.entries(rows)) { v.sort((a, b) => a - b); const med = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2; console.log(k.padEnd(40), String(Math.round(med)).padStart(6), `(${Math.round(v[0])}–${Math.round(v[v.length - 1])})`, `n=${v.length}`) }
