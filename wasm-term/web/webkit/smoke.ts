// Headless smoke test of the dev page in Playwright's WebKit build (Linux WPE
// port), at a desktop viewport and with an iPhone device profile.
//   web/webkit/smoke.sh [base URL]      default http://127.0.0.1:4790
// Needs webkit/install.sh once, the dev server, and mock-llm/up.sh.
//
// This is WebKit's engine on Linux, not Safari: it says whether the page's
// JavaScript, wasm, SharedArrayBuffer/Atomics and Worker use run on
// JavaScriptCore/WebCore. It says nothing about iOS itself: the on-screen
// keyboard, visualViewport changes while it is open, real touch input, iOS
// memory limits, WebGL on Apple GPUs, or the clipboard permission prompts.

import { join } from "node:path";
import { type BrowserContextOptions, devices, type Page, webkit } from "playwright";

const base = (process.argv[2] ?? process.env.WASM_TERM_URL ?? "http://127.0.0.1:4790").replace(/\/$/, "");
const shots = join(import.meta.dir, "../../docs/screenshots");

interface Check {
  name: string;
  ok: boolean;
  detail?: unknown;
}

const screen = (page: Page) => page.evaluate(() => window.wasmTerm?.screen().join("\n") ?? "");
const waitFor = (page: Page, needle: string, timeout = 30_000) =>
  page.waitForFunction(value => window.wasmTerm?.screen().join("\n").includes(value), needle, { timeout });

async function run(profile: string, options: BrowserContextOptions, touch: boolean): Promise<Check[]> {
  const checks: Check[] = [];
  const check = (name: string, ok: unknown, detail?: unknown) => {
    checks.push({ name, ok: !!ok, detail: ok ? undefined : detail });
  };
  const browser = await webkit.launch({ headless: true });
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(String(error)));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  try {
    await page.goto(`${base}/`);
    await page.waitForSelector('form input[name="guest"][value="opencode"]', { state: "attached", timeout: 15_000 });
    check("launcher loads and lists the guests", true);
    check("page is cross-origin isolated (SharedArrayBuffer available)", await page.evaluate(() => crossOriginIsolated && typeof SharedArrayBuffer === "function"));

    await page.goto(`${base}/?guest=opencode&persist=0`);
    const started = await page.waitForFunction(() => !!window.wasmTerm, null, { timeout: 20_000 }).then(() => true, () => false);
    check("terminal opens and the Worker is started", started, await page.locator("#fatal").textContent().catch(() => null));
    check("renderer", true);
    const renderer = await page.evaluate(() => window.wasmTerm?.terminal.renderer?.constructor.name ?? "none");
    checks[checks.length - 1]!.name = `renderer in use: ${renderer}`;

    const home = await waitFor(page, "Ask anything").then(() => true, () => false);
    check("opencode home screen renders (program runs in the Worker and draws)", home, (await screen(page)).split("\n").filter(Boolean).slice(-6));
    const connected = await waitFor(page, "Mock Model", 15_000).then(() => true, () => false);
    check("connected to the server through the same-origin proxy (model name shown)", connected, (await screen(page)).split("\n").filter(Boolean).slice(-4));
    check("terminal fits the viewport", await page.evaluate(() => {
      const canvas = document.querySelector("#terminal canvas")!.getBoundingClientRect();
      return canvas.width <= innerWidth + 1 && canvas.height <= innerHeight + 1 && window.wasmTerm.terminal.cols >= 20;
    }), await page.evaluate(() => [innerWidth, innerHeight, window.wasmTerm.terminal.cols, window.wasmTerm.terminal.rows]));

    if (touch) {
      const focused = () => page.evaluate(() => document.activeElement === window.wasmTerm.terminal.textarea);
      const coarse = await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches);
      check("touch: the text input is not focused on load (no keyboard over an untouched page)", !(await focused()), { coarse });
      // A tap, as touch events: a click for the program, not a request for the keyboard.
      const size = page.viewportSize()!;
      await page.touchscreen.tap(size.width / 2, size.height / 3);
      await page.waitForTimeout(300);
      check("touch: a tap on the terminal does not focus the text input", !(await focused()));
      check("touch: the extra-keys row is shown, inside the viewport", await page.evaluate(() => {
        const keys = document.querySelector<HTMLElement>(".terminal-keys");
        return !!keys && getComputedStyle(keys).display !== "none" && keys.getBoundingClientRect().bottom <= innerHeight + 1;
      }));
      // Focus on the textarea is what makes iOS show its keyboard (the keyboard itself is not observable here).
      await page.locator('.terminal-keys [data-key="Keyboard"]').tap();
      await page.waitForTimeout(200);
      check("touch: the keyboard key focuses the terminal's text input", await focused());
    } else {
      await page.evaluate(() => window.wasmTerm.terminal.focus());
    }
    await page.keyboard.type("hello there", { delay: 10 });
    const typed = await waitFor(page, "hello there", 5_000).then(() => true, () => false);
    check("typed text reaches the program and is echoed in the prompt", typed, await page.evaluate(() => window.wasmTerm.sent.slice(-5)));
    await page.keyboard.press("Enter");
    const replied = await waitFor(page, "no tokens were spent", 20_000).then(() => true, () => false);
    check("prompt is answered: the mock reply streams in (fetch + event stream from the Worker)", replied, (await screen(page)).split("\n").filter(Boolean).slice(0, 8));

    if (touch) {
      // A swipe down over the transcript scrolls it back (touch events -> wheel steps -> mouse reports).
      await page.keyboard.type("long scroll", { delay: 10 });
      await page.keyboard.press("Enter");
      await waitFor(page, "END-OF-LONG-RESPONSE", 40_000).catch(() => {});
      await page.waitForTimeout(500);
      const bottom = await screen(page);
      await page.evaluate(async () => {
        const target = document.querySelector("#terminal")!;
        // Plain events carrying touch lists: WebKit's Linux ports cannot construct Touch.
        const fire = (type: string, y: number) => {
          const touch = { identifier: 1, target, clientX: 180, clientY: y };
          const event = new Event(type, { bubbles: true, cancelable: true });
          Object.assign(event, { touches: type === "touchend" ? [] : [touch], changedTouches: [touch] });
          target.dispatchEvent(event);
        };
        fire("touchstart", 150);
        for (let y = 170; y <= 450; y += 20) { fire("touchmove", y); await new Promise(resolve => setTimeout(resolve, 30)); }
        await new Promise(resolve => setTimeout(resolve, 200)); // a finger that pauses does not coast
        fire("touchend", 450);
      });
      await page.waitForTimeout(600);
      const scrolled = await screen(page);
      check("touch: a swipe scrolls the transcript back", bottom.includes("END-OF-LONG-RESPONSE") && !scrolled.includes("END-OF-LONG-RESPONSE"), scrolled.split("\n").filter(Boolean).slice(-5));
      await page.screenshot({ path: join(shots, "webkit-iphone-scrolled.png") });
      const before = await screen(page);
      await page.locator('.terminal-keys [data-key="Control"]').tap();
      await page.keyboard.type("p");
      const palette = await waitFor(page, "Commands", 5_000).then(() => true, () => false);
      check("touch: Ctrl on the keys row + p opens the command palette", palette, await page.evaluate(() => window.wasmTerm.sent.slice(-3)));
      await page.locator('.terminal-keys [data-key="Escape"]').tap();
      await page.waitForTimeout(600);
      check("touch: Esc on the keys row closes it", !(await screen(page)).includes("Commands") && before.length > 0, await page.evaluate(() => window.wasmTerm.sent.slice(-3)));
    }
    await page.screenshot({ path: join(shots, `webkit-${profile}.png`) });
    if (touch) {
      // Stand-in for the on-screen keyboard: the visible viewport loses its lower 45%.
      // (On iOS only visualViewport shrinks, the layout viewport does not; that difference is not reproduced here.)
      const size = page.viewportSize()!;
      const rowsBefore = await page.evaluate(() => window.wasmTerm.terminal.rows);
      await page.setViewportSize({ width: size.width, height: Math.round(size.height * 0.55) });
      await page.waitForFunction(rows => window.wasmTerm.terminal.rows < rows, rowsBefore, { timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(500);
      const fit = await page.evaluate(() => {
        const keys = document.querySelector(".terminal-keys")!.getBoundingClientRect();
        const canvas = document.querySelector("#terminal canvas")!.getBoundingClientRect();
        const view = window.visualViewport!;
        return { rows: window.wasmTerm.terminal.rows, keysBottom: keys.bottom, canvasBottom: canvas.bottom, keysTop: keys.top, viewHeight: view.height, body: document.body.getBoundingClientRect().height };
      });
      const text = await screen(page);
      check("touch: with the viewport shrunk as by a keyboard, the grid refits and the prompt and keys row stay visible",
        fit.rows < rowsBefore && fit.keysBottom <= fit.viewHeight + 1 && fit.canvasBottom <= fit.keysTop + 1 && Math.abs(fit.body - fit.viewHeight) <= 1 && text.includes("Mock Model"), { rowsBefore, ...fit });
      await page.screenshot({ path: join(shots, "webkit-iphone-keyboard-height.png") });
    }
    check("no page errors", errors.length === 0, errors.slice(0, 5));
  } catch (error) {
    check("the script ran to the end", false, String((error as Error).stack ?? error).slice(0, 500));
    await page.screenshot({ path: join(shots, `webkit-${profile}.png`) }).catch(() => {});
  }
  await browser.close();
  return checks;
}

const profiles: [string, BrowserContextOptions, boolean][] = [
  ["desktop", { viewport: { width: 1280, height: 800 } }, false],
  ["iphone", devices["iPhone 15"]!, true],
];
let failed = 0;
for (const [profile, options, touch] of profiles) {
  if (process.env.PROFILE && process.env.PROFILE !== profile) continue;
  console.log(`\n== WebKit (Linux, headless), ${profile} profile, ${base}`);
  for (const item of await run(profile, options, touch)) {
    if (!item.ok) failed++;
    console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name}${item.ok ? "" : `: ${JSON.stringify(item.detail)}`}`);
  }
}
process.exit(failed ? 1 : 0);
