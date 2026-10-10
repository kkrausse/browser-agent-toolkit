#!/usr/bin/env bun
// Record which image bodies a start-up reads, for `bat-prepare app --order`.
//
//   bun bench/first-open/trace.ts --port 4132 --prepared <prepared dir> --out examples/todo-app/editor-startup-order.txt
//
// Opens the editor once on an origin the browser has never seen (so it is a first open of
// a fresh workspace) with `localStorage['bat-image-trace'] = '1'`: the runtime then has the
// kernel record every positioned read of the image. When the preview shows the app and the
// chat is ready the reads are taken (`__batImageTrace()`), and `bat-prepare order` maps
// them to guest paths using the image that was served. No chat message is sent.
import { $ } from 'bun'
import { join, resolve } from 'node:path'

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? fallback : process.argv[i + 1]
}
const port = arg('port', '4132')!
const session = arg('session', 'bat-gaps')!
const prepared = resolve(arg('prepared')!)
const out = resolve(arg('out', 'editor-startup-order.txt')!)
const bin = arg('bin', process.env.BAT_PREPARE ?? 'bat-prepare')!
const origin = `http://tr-${Date.now().toString(36)}.localhost:${port}`

const code = `
const origin = ${JSON.stringify(origin)}
await page.goto(origin + '/')
await page.bringToFront()
await page.evaluate(() => localStorage.setItem('bat-image-trace', '1'))
const button = page.getByRole('button', { name: 'Open editor' })
await button.waitFor()
await button.click()
await page.waitForFunction(() => {
  const has = (name) => performance.getEntriesByName('bat:' + name).length > 0
  if (document.querySelector('.todo-editor [role=alert]')) throw new Error(document.querySelector('.todo-editor [role=alert]').textContent)
  return has('chat.ready') && has('preview.visible')
}, null, { timeout: 240000, polling: 50 })
const reads = await page.evaluate(() => window.__batImageTrace(0))
await page.getByRole('button', { name: 'Exit' }).click()
await page.getByRole('button', { name: 'Open editor' }).waitFor({ timeout: 30000 })
await page.waitForFunction(() => !document.querySelector('.todo-editor'), null, { timeout: 30000 })
await page.evaluate(async () => {
  localStorage.clear()
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister()
  const root = await navigator.storage.getDirectory()
  for (let attempt = 0; ; attempt++) {
    try {
      for await (const name of root.keys()) await root.removeEntry(name, { recursive: true })
      break
    } catch (e) {
      if (attempt > 50) throw e
      await new Promise((r) => setTimeout(r, 200))
    }
  }
})
await page.goto('about:blank')
return JSON.stringify(reads)
`
const text = await $`browser-control execute --json --session ${session} ${code}`.quiet().nothrow().text()
const parsed = JSON.parse(text)
if (!parsed.ok) throw new Error(`browser-control: ${JSON.stringify(parsed.error ?? parsed.text).slice(0, 2000)}`)
const reads: [number, number][] = JSON.parse(parsed.value)
const manifest = await Bun.file(join(prepared, 'manifest.json')).json()
const traceFile = `${out}.reads.json`
await Bun.write(traceFile, JSON.stringify(reads))
const order = await $`${bin} order ${join(prepared, manifest.image.file)} ${traceFile}`.text()
await Bun.write(out, order)
await $`rm -f ${traceFile}`
console.log(`${reads.length} reads → ${order.split('\n').length - 2} files in ${out}`)
console.log(order.split('\n')[0])
