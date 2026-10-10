#!/usr/bin/env bun
// Markdown tables from the driver's output files.
//   bun bench/startup/report.ts <run.json>...          stages per variant and kind
//   bun bench/startup/report.ts --steps <run.json>     every step (ms after the click)
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const steps = process.argv.includes('--steps')
const cell = (v?: { n: number; median: number; min: number; max: number }) => (v ? `${Math.round(v.median)} (${Math.round(v.min)}–${Math.round(v.max)})` : '–')
for (const file of files) {
  const run = await Bun.file(file).json()
  const columns: [string, any][] = []
  for (const [variant, kinds] of Object.entries(run.summary as Record<string, any>)) {
    // Early files: { fresh, reopen } without a variant level.
    if ('n' in kinds) {
      if (kinds.n) columns.push([`${run.meta.label} ${variant} (n=${kinds.n}, load ${kinds.load1.median})`, kinds])
    } else for (const [kind, s] of Object.entries(kinds as Record<string, any>)) columns.push([`${variant} ${kind} (n=${s.n}, load ${s.load1.median})`, s])
  }
  const rows = new Set<string>()
  for (const [, s] of columns) for (const name of Object.keys(steps ? s.steps : s.stages)) rows.add(name)
  console.log(`\n${file.split('/').pop()} (${run.meta.date}, commit ${run.meta.commit}); ms, median (min–max)\n`)
  console.log(`| | ${columns.map(([name]) => name).join(' | ')} |`)
  console.log(`| --- | ${columns.map(() => '---').join(' | ')} |`)
  for (const name of rows) console.log(`| ${name} | ${columns.map(([, s]) => cell((steps ? s.steps : s.stages)[name])).join(' | ')} |`)
}
