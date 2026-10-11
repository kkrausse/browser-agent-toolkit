#!/usr/bin/env bun
// The README scenario of demo/run.ts in WebKit (Playwright's build; `browser-control` is
// Chromium-only). The example must already be serving; with a scripted model it costs nothing:
//
//   PORT=4311 bun ../terminal-app/mock-model.ts
//   EDITOR_MODEL_API_KEY=not-a-key EDITOR_MODEL_BASE_URL=http://127.0.0.1:4311/v1 PORT=3000 bun run editor
//   bun demo/webkit.ts [--base http://127.0.0.1:3000] [--runs 1] [--profile DIR] [--headed]
//                      [--keep-workspace] [--no-prompt] [--shot out.png] [--trace]
//
// Per run: reset the workspace (unless --keep-workspace), add two todos, tick one, "Open
// editor", wait for the app in the preview and for the chat; send the dark-theme prompt and
// wait for the assistant; the preview must have turned dark in the same document and show
// "1 … left"; then type "Ship it" inside the preview and tick a box there. Prints one JSON
// line per run and exits 1 if any failed.
//
// The profile directory must persist (WebKit refuses OPFS sync access handles in an
// ephemeral context); the default is a fresh one per invocation, so the first run is a
// first-ever open and later runs of the same invocation are reopens.
import { webkit, type Page } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'

const flag = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? undefined : process.argv[at + 1] ?? '' }
const has = (name: string) => process.argv.includes(`--${name}`)
const base = (flag('base') ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`).replace(/\/$/, '')
const runs = Number(flag('runs') ?? 1)
const prompt = flag('prompt') ?? 'Give this app a dark theme with a violet accent, and show how many todos are left under the list.'
const profile = flag('profile') ?? mkdtempSync(join(tmpdir(), 'bat-demo-webkit-'))

const context = await webkit.launchPersistentContext(profile, { headless: !has('headed'), viewport: { width: 1280, height: 800 } })
const page = context.pages()[0] ?? (await context.newPage())
const problems: string[] = []
page.on('pageerror', (e) => problems.push(`pageerror: ${String(e).slice(0, 300)}`))
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 300)}`) })

const panel = (page: Page) => page.evaluate(() => {
  const q = (s: string) => document.querySelector(s)
  const chat = q('.todo-editor-chat'), log = chat?.querySelector('[role=log]')
  const frame = q('.todo-editor-preview iframe') as HTMLIFrameElement | null
  let preview = false
  try { preview = !!frame?.contentDocument?.querySelector('main input#title:not(:disabled)') } catch {}
  return {
    preview, composer: !!chat?.querySelector('textarea'),
    status: q('.todo-editor-panel > footer [role=status]')?.textContent ?? '',
    error: q('.todo-editor-panel > footer [role=alert]')?.textContent ?? '',
    users: log?.querySelectorAll('[aria-label="user message"]').length ?? 0,
    assistants: log?.querySelectorAll('[aria-label="assistant message"]').length ?? 0,
    chatStatus: chat?.querySelector('.oc-connection [role=status]')?.textContent ?? '',
    alerts: [...(chat?.querySelectorAll('[role=alert]') ?? [])].map((e) => (e.textContent ?? '').slice(0, 300)),
    timings: (window as any).__editorTimings?.current ?? {},
  }
})
// What the scenario is about, read from the app inside the preview frame.
const app = (page: Page) => page.evaluate(() => {
  const frame = document.querySelector('.todo-editor-preview iframe') as HTMLIFrameElement | null
  const doc = frame?.contentDocument, win = frame?.contentWindow as any
  if (!doc?.body) return null
  const luminance = (el: Element) => { const m = /rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?/.exec(win.getComputedStyle(el).backgroundColor); return !m || m[4] === '0' ? null : (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255 }
  const text = (doc.querySelector('main') as HTMLElement | null)?.innerText ?? doc.body.innerText
  const left = /(\d+)\s*(?:of\s*\d+\s*)?(?:todos?|items?|tasks?)?\s*(?:left|remaining|to go)/i.exec(text) ?? /(?:left|remaining)\D{0,12}(\d+)/i.exec(text)
  return { background: luminance(doc.body) ?? luminance(doc.documentElement) ?? 1, left: left ? Number(left[1]) : null, text: text.slice(0, 600), sameDocument: win.__demoDocument === true }
})

// Where a hot update gets to, for a run that loses one. Installed in the preview frame once
// it is open: the Vite client's own events (a message it has started to handle), a second
// socket to the dev server (a message that crossed the bridge at all), and the fetches of the
// two edited files. Read back with `traced`, together with the dev server's own lines.
const trace = async () => {
  const win = (document.querySelector('.todo-editor-preview iframe') as HTMLIFrameElement).contentWindow as any
  const log: unknown[][] = (win.__demoTrace = [])
  const brief = (p: any) => p?.updates ? p.updates.map((u: any) => `${u.type} ${u.path} ${u.timestamp}`).join(', ') : p?.route ? `route ${p.route.id}` : p?.type === 'custom' ? `${p.event}` : p?.type ?? ''
  const client = (win.performance.getEntriesByType('resource') as PerformanceEntry[]).map((e) => e.name).find((n) => /@vite\/client$/.test(n))
  if (!client) { log.push([Date.now(), 'no @vite/client in the frame']); return }
  const { createHotContext } = await win.eval(`import(${JSON.stringify(client)})`)
  const hot = createHotContext('/__demo-trace')
  for (const event of ['vite:beforeUpdate', 'vite:afterUpdate', 'vite:beforeFullReload', 'vite:error', 'vite:invalidate', 'vite:ws:connect', 'vite:ws:disconnect', 'react-router:hmr']) hot.on(event, (p: unknown) => log.push([Date.now(), event, brief(p)]))
  new win.PerformanceObserver((list: PerformanceObserverEntryList) => {
    for (const e of list.getEntries()) if (/App\.tsx|style\.css/.test(e.name)) log.push([Date.now(), 'fetched', e.name.slice(e.name.lastIndexOf('/') + 1), `${Math.round(e.duration)} ms`])
  }).observe({ type: 'resource' })
  const token = /const wsToken = "([^"]+)"/.exec(await (await win.fetch(client)).text())?.[1]
  const url = new URL(`..?token=${token}`, client)
  url.protocol = 'ws:'
  const socket = new win.WebSocket(url.href, 'vite-hmr')
  win.__demoTraceSocket = socket
  socket.onmessage = (e: MessageEvent) => { let p: any; try { p = JSON.parse(e.data) } catch { p = { type: 'unparsed' } } log.push([Date.now(), 'socket', p.type, brief(p)]) }
  socket.onclose = (e: CloseEvent) => log.push([Date.now(), 'socket closed', e.code])
}
const traced = (page: Page, since: number) => page.evaluate((since) => {
  const win = (document.querySelector('.todo-editor-preview iframe') as HTMLIFrameElement | null)?.contentWindow as any
  const activity = ((window as any).__demoPreviewLog ?? []) as string[]
  // How the frame got the modules it started with (a size of 0 is a copy the browser kept).
  const first = ((win?.performance.getEntriesByType('resource') ?? []) as PerformanceResourceTiming[]).filter((e) => /\/src\/[\w.-]+$/.test(e.name)).map((e) => [e.name.slice(e.name.lastIndexOf('/') + 1), Math.round(e.startTime), `${Math.round(e.duration)} ms`, e.transferSize, e.encodedBodySize, (e as any).responseStatus])
  return { now: Date.now() - since, first, page: ((win?.__demoTrace ?? []) as [number, ...unknown[]][]).map(([at, ...rest]) => [at - since, ...rest]), activity }
}, since).catch((e) => String(e))

async function once(): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { pass: false, load: loadavg().map((n) => Math.round(n * 100) / 100) }
  let step = 'home', promptSent = 0
  problems.length = 0
  try {
    await page.goto(`${base}/`, { waitUntil: 'load' })
    const box = page.getByRole('textbox', { name: 'New todo' })
    await box.waitFor()
    // Todos live in the server's memory: start from none.
    for (let i = 0; i < 50; i++) {
      await page.locator('main input#title:not(:disabled)').waitFor()
      const buttons = page.getByRole('button', { name: /^Delete / })
      const count = await buttons.count()
      if (!count) break
      await buttons.first().click({ timeout: 3000 }).catch(() => {})
      await page.waitForFunction((n) => document.querySelectorAll('main li').length < n, count, { timeout: 5000 }).catch(() => {})
    }
    if (!has('keep-workspace')) {
      await page.getByRole('button', { name: 'Reset workspace', exact: true }).click()
      await page.locator('aside [role=status]').filter({ hasText: /^\s*Workspace reset\.$/ }).waitFor({ timeout: 20000 })
      await page.reload({ waitUntil: 'load' })
      await box.waitFor()
    }
    for (const title of ['Record a demo GIF', 'Water the plants']) {
      await box.click()
      await page.keyboard.type(title)
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      await page.getByRole('checkbox', { name: title }).waitFor()
    }
    await page.getByRole('checkbox', { name: 'Water the plants' }).click()
    await page.getByRole('checkbox', { name: 'Water the plants', checked: true }).waitFor()

    step = 'open'
    const clicked = Date.now()
    await page.getByRole('button', { name: 'Open editor', exact: true }).click()
    // The dev server's own lines, kept as they pass: the panel's log holds the last 500 of all sources.
    await page.evaluate(() => {
      const kept: string[] = ((window as any).__demoPreviewLog = []), seen = new Set<string>()
      const read = () => { for (const line of (document.querySelector('.todo-editor-panel details pre')?.textContent ?? '').split('\n')) if (line.startsWith('[preview]') && !seen.has(line)) { seen.add(line); kept.push(line) } }
      setInterval(read, 100)
    })
    let s = await panel(page)
    for (;;) {
      s = await panel(page)
      if (s.preview && s.composer && /^Ready/.test(s.status)) break
      if (s.error) throw Error(`The editor failed to open: ${s.error}`)
      if (Date.now() - clicked > 180000) throw Error(`The editor was not ready within 180 s: ${JSON.stringify(s)}`)
      await page.waitForTimeout(100)
    }
    result.openMs = Date.now() - clicked
    result.timings = s.timings
    const before = await app(page)
    if (!before || before.background < 0.5) throw Error(`The app does not start light: ${JSON.stringify(before)}`)
    // Survives hot updates, not a reload of the frame.
    await page.evaluate(() => { ((document.querySelector('.todo-editor-preview iframe') as HTMLIFrameElement).contentWindow as any).__demoDocument = true })
    await page.evaluate(trace).catch((e) => problems.push(`trace: ${String(e).slice(0, 200)}`))

    // What the browser may reuse of the dev server's answers. A source module must arrive with
    // `Vary: *`: without it WebKit answered a reopened preview's preloaded modules from its
    // memory cache, never asking the new dev server, which then sent no hot update for them
    // (report section 10). An optimized dependency states a lifetime and is left alone. The
    // module asked for is not one the prompt edits, so the question does not change the run.
    step = 'cache'
    const kept = await page.evaluate(async (probe) => {
      const win = (document.querySelector('.todo-editor-preview iframe') as HTMLIFrameElement).contentWindow as Window & typeof globalThis
      const ask = async (url: string | URL) => { const h = (await win.fetch(url)).headers; return { vary: h.get('vary'), cacheControl: h.get('cache-control') } }
      const dep = win.performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/deps\/[^?]+\?v=/.test(n))
      return { source: await ask(new URL(probe, win.document.baseURI)), dep: dep ? await ask(dep) : null }
    }, 'src/main.tsx')
    result.reuse = kept
    if (kept.source.vary !== '*') throw Error(`A source module of the preview can be reused from the browser's memory cache: Vary ${JSON.stringify(kept.source.vary)}, expected "*"`)
    if (kept.dep && (kept.dep.vary === '*' || !/immutable|max-age/.test(kept.dep.cacheControl ?? ''))) throw Error(`An optimized dependency lost its lifetime: ${JSON.stringify(kept.dep)}`)

    if (!has('no-prompt')) {
      step = 'prompt'
      const start = await panel(page)
      await page.locator('.todo-editor-chat textarea').first().click()
      await page.keyboard.type(prompt)
      await page.keyboard.press('Enter')
      const sent = Date.now()
      promptSent = sent
      let busy = false
      for (;;) {
        s = await panel(page)
        if (s.chatStatus && s.chatStatus !== 'Ready') busy = true
        if (s.alerts.length > start.alerts.length) throw Error(`The chat reported: ${s.alerts.at(-1)}`)
        if (s.assistants > start.assistants && s.chatStatus === 'Ready' && (busy || Date.now() - sent > 3000)) break
        if (Date.now() - sent > 240000) throw Error(`The assistant did not finish within 240 s: ${JSON.stringify(s)}`)
        await page.waitForTimeout(150)
      }
      result.replyMs = Date.now() - sent
      result.tools = await page.evaluate(() => (document.querySelector('.todo-editor-chat [role=log]') as HTMLElement | null)?.innerText.match(/\b(read|edit|write|grep|glob|runJavascript)\s*(completed|error)/g) ?? [])

      step = 'preview'
      const expectLeft = async (n: number, what: string) => {
        const deadline = Date.now() + 10000
        for (;;) {
          const a = await app(page)
          if (a?.left === n) return a
          if (Date.now() > deadline) throw Error(`${what}: expected ${n} left, the preview shows: ${JSON.stringify(a?.text)}`)
          await page.waitForTimeout(100)
        }
      }
      const after = await expectLeft(1, 'after the change')
      if (after.background > 0.3) throw Error(`The preview is not dark: background luminance ${after.background}`)
      if (!after.sameDocument) throw Error('The preview was reloaded instead of hot-updated')
      const frame = page.frameLocator('.todo-editor-preview iframe')
      await frame.locator('input#title').click()
      await page.keyboard.type('Ship it')
      await page.keyboard.press('Enter')
      await expectLeft(2, 'after adding "Ship it" inside the preview')
      await frame.getByRole('checkbox').first().click()
      result.end = await expectLeft(1, 'after ticking the first todo inside the preview')
    }
    result.pass = true
  } catch (e) {
    result.failed = step
    result.error = String((e as Error)?.message ?? e).slice(0, 1500)
    // What the preview shows at the failure (theme applied or not, same document or not).
    result.preview = await app(page).catch(() => null)
    // Whether the dev server has the agent's last edit: its answer for the module, asked now and uncached.
    result.served = await page.evaluate(async () => {
      const win = (document.querySelector('.todo-editor-preview iframe') as HTMLIFrameElement | null)?.contentWindow as (Window & typeof globalThis) | null | undefined
      if (!win) return null
      const out: Record<string, unknown> = {}
      for (const path of ['src/App.tsx']) {
        const text = await win.fetch(new URL(`${path}?t=${Date.now()}`, win.document.baseURI)).then((r) => (r.ok ? r.text() : `HTTP ${r.status}`), (e) => String(e))
        out[path] = { bytes: text.length, hasCount: /const left\b/.test(text), hasLine: /className: "left"/.test(text) }
      }
      // And what the document itself has loaded of it: the hot updates it took, in order.
      out.loaded = win.performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /App\.tsx/.test(n)).map((n) => n.slice(n.indexOf('App.tsx')))
      return out
    }).catch((e) => String(e))
  }
  // Times in `trace` are milliseconds after the prompt was sent.
  if (promptSent && (!result.pass || has('trace'))) result.trace = await traced(page, promptSent)
  if (flag('shot')) await page.screenshot({ path: flag('shot')! }).catch(() => {})
  result.problems = [...new Set(problems)].slice(0, 12)
  return result
}

let failed = 0
for (let i = 0; i < runs; i++) {
  const r = await once()
  if (!r.pass) failed++
  console.log(JSON.stringify(r))
}
await context.close()
process.exit(failed ? 1 : 0)
