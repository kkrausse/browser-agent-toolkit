#!/usr/bin/env bun
// WebKit side of the harness: one long-lived Playwright WebKit with a persistent
// profile, and a local HTTP endpoint that runs a piece of driver code against
// its page. It plays the part `browser-control execute` plays for Chrome, so
// cli.ts sends the same code to either.
//
//   bun runtime/harness/webkit/driver.ts [port=4103]
//   POST /execute   body: the text of an async function body with `page` and `context` in scope
//                   → { ok: true, value } | { ok: false, error }
//   GET  /log       console messages, page errors and failed requests since the last call (JSON lines)
//   POST /stop      close the browser and exit
//
// Environment: BAT_WEBKIT_PROFILE (profile directory; default a directory in the system
// temp directory per port), BAT_WEBKIT_HEADED=1 (a window on $DISPLAY instead of headless).
//
// The profile must be persistent: in Playwright's default (ephemeral) context WebKit
// refuses OPFS sync access handles ("UnknownError … transient reason").
import { webkit, type Page } from 'playwright'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = Number(process.argv[2] ?? process.env.BAT_HARNESS_WEBKIT_PORT ?? 4103)
const profile = process.env.BAT_WEBKIT_PROFILE ?? join(tmpdir(), `bat-harness-webkit-${port}`)
const context = await webkit.launchPersistentContext(profile, { headless: process.env.BAT_WEBKIT_HEADED !== '1', viewport: { width: 1280, height: 800 } })
let page: Page = context.pages()[0] ?? (await context.newPage())

const lines: string[] = []
const note = (kind: string, text: string) => {
  lines.push(JSON.stringify({ t: Date.now(), kind, text: text.slice(0, 4000) }))
  if (lines.length > 5000) lines.splice(0, lines.length - 5000)
}
function watch(p: Page) {
  p.on('console', (m) => note(`console.${m.type()}`, `${m.text()}${m.location().url ? `  (${m.location().url}:${m.location().lineNumber})` : ''}`))
  p.on('pageerror', (e) => note('pageerror', String(e.stack ?? e)))
  p.on('requestfailed', (r) => note('requestfailed', `${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`))
  p.on('crash', () => note('crash', p.url()))
  p.on('worker', (w) => note('worker', w.url()))
}
watch(page)
context.on('page', (p) => {
  if (p !== page) watch(p)
})
context.on('weberror', (e) => note('weberror', String(e.error().stack ?? e.error())))

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  idleTimeout: 255,
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/') return json({ ok: true, browser: 'webkit', version: context.browser()?.version(), profile })
    if (path === '/log') return new Response(lines.splice(0).join('\n'), { headers: { 'content-type': 'text/plain' } })
    if (path === '/stop') {
      setTimeout(async () => {
        await context.close().catch(() => {})
        process.exit(0)
      }, 10)
      return json({ ok: true })
    }
    if (path === '/execute' && req.method === 'POST') {
      try {
        if (page.isClosed()) {
          page = await context.newPage()
          watch(page)
        }
        const value = await new AsyncFunction('page', 'context', await req.text())(page, context)
        return json({ ok: true, value: value === undefined ? null : value })
      } catch (e) {
        return json({ ok: false, error: String((e as Error)?.stack ?? e) })
      }
    }
    return json({ ok: false, error: 'not found' }, 404)
  },
})
console.log(`webkit harness driver on http://127.0.0.1:${server.port}/  (WebKit ${context.browser()?.version()}, profile ${profile})`)
