#!/usr/bin/env bun
// Records the two start-up recordings of the app this page shows (app.ts), from one real
// first open of a served build in Chrome (the `browser-control` CLI):
//
//   <app>/startup-modules.json        what the app's dev server had loaded once the app
//                                     showed and the terminal was up
//   <app>/editor-startup-order.txt    what that start read from the dependency image
//
// `prepare.ts` passes both on when the app's `terminal-app.json` names them. They only cost
// speed when stale; record them again after a dependency upgrade, then prepare and build again.
//
//   BAT_APP=../start-app bun record.ts --port 4320 [--session <name>]
//
// The page is opened on a host name the browser has not seen (`rec-….localhost`), so it is
// a first open of a fresh workspace. No prompt is sent.
import { $ } from 'bun'
import { join } from 'node:path'
import { editedApp } from './app'

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? fallback : process.argv[i + 1]
}
const app = editedApp()
const session = arg('session', 'bat-record')!
const bin = process.env.BAT_PREPARE ?? join(import.meta.dirname, '../../target/release/bat-prepare')
const url = `http://rec-${Date.now().toString(36)}.localhost:${arg('port', '4310')}/?diag=0`

const code = `
await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded' })
await page.evaluate(() => { localStorage.setItem('bat-trace', '1'); localStorage.setItem('bat-image-trace', '1') })
await page.reload({ waitUntil: 'domcontentloaded' })
for (const started = Date.now(); ; await page.waitForTimeout(200)) {
  const frame = page.frames().find(frame => frame.url().includes('/preview/'))
  const shown = frame && await frame.evaluate(() => document.body?.innerText.trim().length > 0).catch(() => false)
  if (shown && await page.evaluate(() => !!window.batTerminal?.terminal)) break
  if (Date.now() - started > 240000) throw Error('The page did not start: ' + await page.locator('#status').innerText().catch(() => ''))
}
await page.waitForTimeout(3000)
await page.evaluate(() => new BroadcastChannel('bat-trace').postMessage({ cmd: 'modules' }))
await page.waitForTimeout(1500)
const result = await page.evaluate(() => ({
  modules: (window.__batTrace ?? []).filter(mark => mark.name === 'modules' && mark.data?.modules).map(mark => ({ script: String(mark.data.argv?.[1] ?? ''), modules: mark.data.modules })),
  reads: window.__batImageTrace(0),
}))
await page.goto('about:blank')
return JSON.stringify(result)
`
interface Recorded { modules: { script: string; modules: string[] }[]; reads: [number, number][] }
const answer = JSON.parse(await $`browser-control execute --json --session ${session} ${code}`.quiet().nothrow().text()) as { ok: boolean; value?: string; text?: string; error?: unknown }
const returned = answer.ok ? answer.value ?? answer.text : undefined
if (!returned) throw Error(`browser-control: ${JSON.stringify(answer.error ?? answer).slice(0, 2000)}`)
const recorded = JSON.parse(returned) as Recorded

// The dev server's modules. (The OpenCode server is one bundle that prepare already ships as
// a program.) Workspace files are never part of an image.
const preview = new Set<string>()
for (const { script, modules } of recorded.modules) {
  if (script.includes('/vite/')) for (const path of modules) if (path.includes('/node_modules/')) preview.add(path)
}
const modulesFile = join(app.root, app.startupModules ?? 'startup-modules.json')
await Bun.write(modulesFile, JSON.stringify({ preview: [...preview].sort() }, null, 1) + '\n')
console.log(`preview: ${preview.size} modules -> ${modulesFile}`)

const manifest = await Bun.file(join(app.prepared, 'manifest.json')).json() as { image: { file: string } }
const readsFile = join(app.prepared, '.reads.json')
await Bun.write(readsFile, JSON.stringify(recorded.reads))
const order = await $`${bin} order ${join(app.prepared, manifest.image.file)} ${readsFile}`.text()
await $`rm -f ${readsFile}`
const orderFile = join(app.root, app.startupOrder ?? 'editor-startup-order.txt')
await Bun.write(orderFile, order)
console.log(`${recorded.reads.length} reads, ${order.split('\n').length - 2} files -> ${orderFile}`)
