// The prototype page in Playwright's WebKit build (headless, Linux WPE port;
// wasm-term/web/webkit/install.sh puts it under vendor/). It is WebKit's
// engine, not Safari and not iOS: it shows whether nested SharedArrayBuffer
// channels, Atomics.wait in two kinds of Worker, a WebAssembly.Module sent by
// postMessage and Worker replacement behave on JavaScriptCore.
//   web/webkit.sh ['query'] [desktop|iphone]      (server must be up: bun web/server.ts)
import { devices, webkit } from "playwright";

const query = process.argv[2] ?? "";
const profile = process.argv[3] ?? "desktop";
const browser = await webkit.launch({ headless: true });
const context = await browser.newContext(profile === "iphone" ? devices["iPhone 15"] : {});
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", error => errors.push(String(error)));
await page.goto(`http://127.0.0.1:${process.env.PORT ?? 4797}/?${query}`);
const done = await page.waitForFunction(() => (globalThis as any).shellProto?.done, null, { timeout: 240_000 }).then(() => true, () => false);
const value = await page.evaluate(() => {
  const state = (globalThis as any).shellProto;
  return { crossOriginIsolated, userAgent: navigator.userAgent, exit: state.exit, workerStarts: state.workerStarts, result: state.result, tail: state.result ? undefined : state.output.slice(-3000) };
});
console.log(JSON.stringify({ ok: done, profile, errors, value }));
await browser.close();
