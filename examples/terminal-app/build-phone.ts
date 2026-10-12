#!/usr/bin/env bun
// The public build with its diagnostics panel always on, beside the standalone probes, as one
// directory to put on any static https host and open on a phone:
//
//   index.html             links
//   demo/                  `PUBLIC=1 DIAG_PANEL=1 bun build.ts` (README.md, "The public build")
//   probes/                phone/probes: feature probe, preload reuse, shared-memory grow crash,
//                          with a service worker of their own for cross-origin isolation
//
//   bun build-phone.ts            after a setup, `bun run display` and `bun run prepare:editor`
//   OUT_DIR=…                     another output directory (default dist-phone/)
//   DIAG_URL=https://…/diag       a collector (diag-collector.ts) the panel posts its readout to; none by default
// It publishes nothing: copy the directory to a host yourself.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const here = import.meta.dirname
const out = resolve(here, process.env.OUT_DIR ?? 'dist-phone')
mkdirSync(out, { recursive: true })
const build = Bun.spawnSync(['bun', 'build.ts'], { cwd: here, env: { ...process.env, PUBLIC: '1', DIAG_PANEL: '1', OUT_DIR: join(out, 'demo'), MODEL_URL: '' }, stdout: 'inherit', stderr: 'inherit' })
if (build.exitCode !== 0) throw Error('The public build failed')
rmSync(join(out, 'probes'), { recursive: true, force: true })
cpSync(join(here, 'phone/probes'), join(out, 'probes'), { recursive: true })
// The crash page's worker is the harness's own, unchanged.
cpSync(resolve(here, '../../runtime/harness/webkit/grow-crash/worker.js'), join(out, 'probes/grow-worker.js'))
const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: here }).stdout.toString().trim()
const commit = `${git('rev-parse', '--short', 'HEAD')}${git('status', '--porcelain') ? '+changes' : ''}`
writeFileSync(join(out, 'index.html'), readFileSync(join(here, 'phone/index.html'), 'utf8').replace('__COMMIT__', commit).replace('__BUILT__', new Date().toISOString().slice(0, 16) + 'Z'))
console.log(`Built ${out} (${commit}): index.html, demo/, probes/`)
