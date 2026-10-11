#!/usr/bin/env bun
// WebKit reuses a preloaded module from its memory cache without asking the server, whatever
// its Cache-Control says. No runtime involved: a Bun server, a page with a frame, Playwright.
//
//   bun runtime/harness/webkit/preload-reuse/run.ts [--loads 40] [--profile DIR] [--only NAME]
//
// The frame's document has `<link rel="modulepreload" href="m.js">` and imports `m.js`,
// whose text changes at every load of the page (it exports the load's number). Per variant
// the page is loaded `--loads` times; a load is "unasked" if the server got no request for
// `m.js` during it and "stale" if the frame ran an earlier load's module.
//
//   no-cache          Vite's header for source modules     stale in about half of the loads
//   no-store                                               the same
//   no-link           no-store, without the <link>         never stale: it takes the preload
//   vary-star         no-store and `Vary: *`               never stale
//
// This is why the preview's service worker puts `Vary: *` on a guest's answers
// (runtime/src/sw/sw.ts, docs/experiments/2026-10-11-webkit.md section 10): a preview opened
// again got the previous dev server's modules, and the new server never hot-updated them.
// Exits 1 if `vary-star` or `no-link` is ever stale, or if neither plain variant ever is
// (then the browser no longer does this and the header can go).
import { webkit } from 'playwright'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const flag = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? undefined : process.argv[at + 1] }
const loads = Number(flag('loads') ?? 40)
// Not /tmp: a WebKit profile is tens of megabytes and the machine's /tmp is a tmpfs.
const profile = resolve(flag('profile') ?? resolve(import.meta.dir, '../../../../.diagnostics/preload-reuse'))
mkdirSync(profile, { recursive: true })

interface Variant { name: string; cacheControl: string; link: boolean; vary?: string }
const variants: Variant[] = [
  { name: 'no-cache', cacheControl: 'no-cache', link: true },
  { name: 'no-store', cacheControl: 'no-store', link: true },
  { name: 'no-link', cacheControl: 'no-store', link: false },
  { name: 'vary-star', cacheControl: 'no-store', link: true, vary: '*' },
].filter((v) => !flag('only') || v.name === flag('only'))

let current = variants[0]!, load = 0, asked = 0
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    const path = new URL(request.url).pathname
    const answer = (type: string, body: string) => new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': current.cacheControl, ...(current.vary ? { Vary: current.vary } : {}) } })
    // Each variant has its own directory, so one variant's copies cannot answer for another.
    const dir = `/${current.name}/`
    if (path === dir) return answer('text/html', `<!doctype html><title>top</title><iframe src="${dir}frame/"></iframe>`)
    if (path === `${dir}frame/`) return answer('text/html', `<!doctype html><title>frame</title>${current.link ? `<link rel="modulepreload" href="${dir}frame/m.js">` : ''}<script type="module">window.ran = (await import('${dir}frame/m.js')).load</script>`)
    if (path === `${dir}frame/m.js`) { asked++; return answer('text/javascript', `export const load = ${load}`) }
    return new Response('not found', { status: 404 })
  },
})

const context = await webkit.launchPersistentContext(profile, { headless: true })
const page = context.pages()[0] ?? (await context.newPage())
const results: Record<string, { loads: number; unasked: number; stale: number }> = {}
for (const variant of variants) {
  current = variant
  const result = (results[variant.name] = { loads, unasked: 0, stale: 0 })
  for (load = 1; load <= loads; load++) {
    const before = asked
    await page.goto(`http://127.0.0.1:${server.port}/${variant.name}/`)
    await page.waitForFunction(() => (document.querySelector('iframe')?.contentWindow as any)?.ran !== undefined)
    const ran = await page.evaluate(() => (document.querySelector('iframe')!.contentWindow as any).ran)
    if (asked === before) result.unasked++
    if (ran !== load) result.stale++
    await page.waitForTimeout(100)
  }
  console.log(JSON.stringify({ variant: variant.name, ...result }))
}
await context.close()
server.stop(true)
const stale = (name: string) => results[name]?.stale ?? 0
const broken = stale('vary-star') > 0 || stale('no-link') > 0
const gone = !flag('only') && stale('no-cache') === 0 && stale('no-store') === 0
if (broken) console.log('FAIL: a variant that must never be stale was')
if (gone) console.log('FAIL: no plain variant was stale; this WebKit does not reuse preloads, and the Vary header may no longer be needed')
process.exit(broken || gone ? 1 : 0)
