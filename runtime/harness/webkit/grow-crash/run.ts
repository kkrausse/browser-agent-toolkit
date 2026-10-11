#!/usr/bin/env bun
// A WebKit crash without any of the runtime: one thread grows a shared WebAssembly.Memory
// while workers that hold instances importing it are terminated. In Playwright's WebKit 27.2
// (build 2370) the web process dies within seconds, in
// JSC::JSWebAssemblyInstance::updateMatchingCachedMemoriesConcurrently (called by
// SharedArrayBufferContents::tryGrow for every instance attached to the memory): a null read
// at address 0x10. docs/experiments/2026-10-11-webkit.md, section 9.
//
//   bun runtime/harness/webkit/grow-crash/server.ts 4174 &
//   bun runtime/harness/webkit/grow-crash/run.ts 4174 [rounds=20] [race|nogrow] [webkit|chromium]
//
// `nogrow` is the control: the same workers and terminations, nothing grows. For Safari, serve
// the directory with server.ts (it sends the isolation headers), open the page and run
// `go(20, 'race')` in the console: the tab reloading with "a problem repeatedly occurred" is
// the crash; `state.done` true is a pass.
import { webkit, chromium } from 'playwright'
const [port, rounds = '20', variant = 'race', which = 'webkit'] = process.argv.slice(2)
const browser = await (which === 'chromium' ? chromium : webkit).launch({ headless: true })
const page = await browser.newPage()
let crashed = false
page.on('crash', () => { crashed = true; console.log('PAGE CRASH event') })
page.on('console', (m) => console.log('console', m.text()))
page.on('pageerror', (e) => console.log('pageerror', String(e)))
await page.goto(`http://127.0.0.1:${port}/`)
const t0 = Date.now()
const r = await Promise.race([page.evaluate(([n, v]) => (window as any).go(Number(n), v), [rounds, variant]).catch((e) => 'evaluate failed: ' + String(e).slice(0, 200)), new Promise((res) => { const i = setInterval(() => { if (crashed) { clearInterval(i); res('crashed') } }, 100) })])
console.log(JSON.stringify({ variant, which, result: r, crashed, ms: Date.now() - t0 }))
await browser.close().catch(() => {})
process.exit(0)
