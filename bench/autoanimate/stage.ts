#!/usr/bin/env bun
// Gather what autoanimate's check, lint and find need at run time from a built
// autoanimate checkout into one directory, laid out as the checkout is, with a
// files.json listing: what run.ts copies into the guest.
//
//   bun bench/autoanimate/stage.ts <autoanimate checkout> <out dir> [scenes=gromen-excerpt, comma separated]
//
// The checkout needs `bun scene-api/guest/build.ts` (the three bundles),
// scene-api/pkg and scene-api/lint-pkg (the two wasm), scene-api/node_modules
// and scenes/<scene>/film/words.json of each scene. Prints the size of each group, raw and
// gzipped (what a static host would send).
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const [checkout, out, scenes = 'gromen-excerpt'] = process.argv.slice(2)
if (!checkout || !out) {
  console.error('usage: bun bench/autoanimate/stage.ts <autoanimate checkout> <out dir> [scenes]')
  process.exit(2)
}

interface Group {
  name: string
  /** Paths from the checkout root: a file, or a directory taken whole (filtered by `keep`). */
  paths: string[]
  keep?: (path: string) => boolean
}

const groups: Group[] = [
  { name: 'bundles (check, lint, find)', paths: ['scene-api/guest/dist'], keep: (path) => !path.endsWith('probe.mjs') },
  { name: 'probe bundle (measurement only)', paths: ['scene-api/guest/dist/probe.mjs'] },
  { name: 'TypeScript compiler', paths: ['scene-api/node_modules/typescript/package.json', 'scene-api/node_modules/typescript/lib/typescript.js'] },
  { name: 'TypeScript lib .d.ts', paths: ['scene-api/node_modules/typescript/lib'], keep: (path) => /\/lib\.([^/]*\.)?d\.ts$/.test(path) },
  { name: 'authoring wasm', paths: ['scene-api/pkg/scene_api_bg.wasm'] },
  { name: 'lint wasm', paths: ['scene-api/lint-pkg/plan_lint_bg.wasm'] },
  { name: 'pictograms', paths: ['scene-api/data/pictograms'] },
  { name: 'scene-api/src (check emits declarations from it)', paths: ['scene-api/src', '.agents/skills/typescript-scene/API.md'] },
  ...scenes.split(',').map((scene) => ({ name: `scene ${scene}`, paths: [`scenes/${scene}`], keep: (path: string) => /\.ts$|\/film\/words\.json$/.test(path) })),
]

const walk = (path: string): string[] =>
  statSync(path).isDirectory() ? readdirSync(path).flatMap((name) => walk(join(path, name))) : [path]

rmSync(out, { recursive: true, force: true })
const files: { path: string; size: number }[] = []
const mb = (bytes: number) => (bytes / 1e6).toFixed(2)
console.log('group'.padEnd(52), 'files'.padStart(5), 'MB'.padStart(7), 'gzip MB'.padStart(8))
let total = 0
let totalGzip = 0
for (const group of groups) {
  let size = 0
  let gzip = 0
  let count = 0
  for (const each of group.paths) {
    const from = join(checkout, each)
    if (!existsSync(from)) throw new Error(`no ${from}`)
    for (const path of walk(from)) {
      if (group.keep && !group.keep(path)) continue
      const within = relative(checkout, path)
      mkdirSync(dirname(join(out, within)), { recursive: true })
      cpSync(path, join(out, within))
      const bytes = readFileSync(path)
      files.push({ path: within, size: bytes.length })
      size += bytes.length
      gzip += Bun.gzipSync(bytes).length
      count++
    }
  }
  total += size
  totalGzip += gzip
  console.log(group.name.padEnd(52), String(count).padStart(5), mb(size).padStart(7), mb(gzip).padStart(8))
}
console.log('total'.padEnd(52), String(files.length).padStart(5), mb(total).padStart(7), mb(totalGzip).padStart(8))
writeFileSync(join(out, 'files.json'), JSON.stringify(files))
