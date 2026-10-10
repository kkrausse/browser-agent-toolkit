#!/usr/bin/env bun
// Image identity across toolkit rebuilds, and collection of old images, checked in Chrome.
//
//   bun bench/first-open/identity.ts --tree new --port 4132 --proxy 4131
//
// In the private tree (bench/first-open/sync.sh): open the editor on a never-seen origin
// (through the byte-counting proxy), then twice: change the toolkit's source, rebuild it,
// prepare again, restart the server, reopen. Each time it reports the manifest's image
// names, the bytes that crossed the wire for image files, and what the origin's OPFS
// holds. On the second rebuild the editor is first left open in one tab while a second
// tab tries the new deployment (it must be refused, and the first tab's images must
// survive), then the first tab is closed and the second opens.
import { $ } from 'bun'
import { appendFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? fallback : process.argv[i + 1]
}
const root = resolve(import.meta.dir, '../..')
const tree = join(root, 'target-gaps', arg('tree', 'new')!)
const port = arg('port', '4132')!
const proxy = arg('proxy', '4131')!
const session = arg('session', 'bat-gaps')!
const origin = `http://id-${Date.now().toString(36)}.localhost:${proxy}`
const app = join(tree, 'examples/todo-app')
const env = {
  ...process.env,
  CARGO_TARGET_DIR: join(root, 'target-gaps'),
  BAT_PREPARE: join(root, 'target-gaps/release/bat-prepare'),
  BAT_OPENCODE_DIR: join(root, '.runtime/opencode-2.0.3'),
  BAT_RUNTIME_DIR: join(tree, 'runtime/dist'),
}

async function execute<T>(code: string): Promise<T> {
  const text = await $`browser-control execute --json --session ${session} ${code}`.quiet().nothrow().text()
  const parsed = JSON.parse(text)
  if (!parsed.ok) throw new Error(`browser-control: ${JSON.stringify(parsed.error ?? parsed.text).slice(0, 1500)}`)
  return JSON.parse(parsed.value)
}
const manifestImages = () => {
  const m = JSON.parse(readFileSync(join(app, '.editor/prepared/manifest.json'), 'utf8'))
  return { image: m.image.file as string, layers: (m.layers ?? []).map((l: any) => l.file as string) }
}
const wire = async (reset = false) => {
  if (reset) return void (await fetch(`http://127.0.0.1:${proxy}/__proxy/reset`, { method: 'POST' }))
  const stats = (await (await fetch(`http://127.0.0.1:${proxy}/__proxy/stats`)).json()) as { bytes: Record<string, number> }
  return Object.fromEntries(Object.entries(stats.bytes).filter(([path]) => /image-|program-|derived-/.test(path)))
}
const opfs = `async () => {
  const out = []
  const walk = async (dir, prefix) => { for await (const [name, h] of dir.entries()) { if (h.kind === 'directory') await walk(h, prefix + name + '/'); else if (prefix.includes('images')) out.push(name + ' ' + (await h.getFile()).size) } }
  await walk(await navigator.storage.getDirectory(), '')
  return out.sort()
}`
/** Open the editor in the session's page; leaves it open. Returns boot facts and the OPFS image files. */
const open = (expectBusy = false) => execute<any>(`
  await page.goto(${JSON.stringify(origin)} + '/')
  await page.bringToFront()
  await page.getByRole('button', { name: 'Open editor' }).click()
  const outcome = await (await page.waitForFunction(() => {
    const has = (name) => performance.getEntriesByName('bat:' + name).length > 0
    const alert = document.querySelector('.todo-editor [role=alert]')
    if (alert) return 'failed: ' + alert.textContent
    return has('chat.ready') && has('preview.visible') ? 'ok' : false
  }, null, { timeout: 240000, polling: 100 })).jsonValue()
  if (outcome === 'ok') await page.waitForFunction(() => {
    const marks = performance.getEntriesByType('mark').filter((m) => m.name.startsWith('bat:boot.'))
    const image = marks.find((m) => m.name === 'bat:boot.image')
    return image && (!image.detail?.imageArriving || marks.some((m) => m.name === 'bat:boot.image-complete'))
  }, null, { timeout: 240000, polling: 100 })
  // Past the collector's second attempt at files a just-closed editor still held.
  await page.waitForTimeout(7000)
  // The preview really runs the guest's Vite with the toolkit's plugin from the layer image.
  const preview = outcome === 'ok' ? await page.evaluate(() => document.querySelector('.todo-editor iframe')?.contentDocument?.querySelector('main input#title') ? 'app rendered' : 'no app') : undefined
  return JSON.stringify({ outcome, preview, images: await page.evaluate(${opfs}) })
`)
const exit = () => execute<any>(`
  await page.getByRole('button', { name: 'Exit' }).click()
  await page.getByRole('button', { name: 'Open editor' }).waitFor({ timeout: 30000 })
  await page.waitForFunction(() => !document.querySelector('.todo-editor'), null, { timeout: 30000 })
  return JSON.stringify(true)
`)
async function rebuildToolkit(note: string) {
  // A real source change that reaches dist (the chat's stylesheet and a module).
  appendFileSync(join(tree, 'packages/toolkit/src/vite.ts'), `\nexport const rebuilt_${note.replace(/\W/g, '_')}_${Date.now().toString(36)} = true;\n`)
  appendFileSync(join(tree, 'packages/toolkit/src/chat/styles.css'), `\n/* ${note} */\n`)
  await $`bun run build`.cwd(join(tree, 'packages/toolkit')).env(env).quiet()
  await $`bun run prepare:editor`.cwd(app).env(env).quiet()
  await $`bun run build`.cwd(app).env(env).quiet()
  await $`${join(root, 'bench/first-open/serve.sh')} ${port} ${arg('tree', 'new')!}`.quiet()
}
const report = (label: string, value: unknown) => console.log(`${label}: ${JSON.stringify(value)}`)

console.log(`origin ${origin}`)
report('manifest 0', manifestImages())
await wire(true)
report('first open', await open())
report('wire', await wire())
await exit()

await rebuildToolkit('rebuild one')
report('manifest 1', manifestImages())
await wire(true)
report('reopen after rebuild 1', await open())
report('wire', await wire())

// The editor stays open in this tab. Deploy rebuild two and let a second tab try it.
await rebuildToolkit('rebuild two')
report('manifest 2', manifestImages())
await wire(true)
report('second tab while the first is open', await execute<any>(`
  const other = await page.context().newPage()
  try {
    await other.goto(${JSON.stringify(origin)} + '/')
    await other.getByRole('button', { name: 'Open editor' }).click()
    const alert = other.locator('.todo-editor [role=alert]')
    await alert.waitFor({ timeout: 60000 })
    const message = await alert.textContent()
    await other.waitForTimeout(1000)
    // The first tab still reads its images: a file of the layer it mounted, through its own kernel.
    const firstTab = await page.evaluate(async () => {
      const frame = document.querySelector('.todo-editor iframe')
      const r = await frame.contentWindow.fetch(frame.contentWindow.location.pathname + '@vite/client')
      return r.status + ' ' + (await r.text()).length
    })
    return JSON.stringify({ message, firstTabPreviewFetch: firstTab, images: await other.evaluate(${opfs}) })
  } finally {
    await other.close()
  }
`))
await exit()
report('reopen after rebuild 2 (first tab closed)', await open())
report('wire', await wire())
await exit()
await execute(`
  await page.evaluate(async () => {
    localStorage.clear()
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister()
    const root = await navigator.storage.getDirectory()
    for (let attempt = 0; ; attempt++) {
      try { for await (const name of root.keys()) await root.removeEntry(name, { recursive: true }); break } catch (e) { if (attempt > 50) throw e; await new Promise((r) => setTimeout(r, 200)) }
    }
  })
  await page.goto('about:blank')
  return JSON.stringify(true)
`)
