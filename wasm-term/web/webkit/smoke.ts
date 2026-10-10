// Headless smoke test of the dev page in Playwright's WebKit build (Linux WPE
// port), at a desktop viewport and with an iPhone device profile.
//   web/webkit/smoke.sh [base URL]      default http://127.0.0.1:4790
//   GUESTS=opencode,codex,proc,codex-local   which guests to run (default all four); PROFILE=desktop|iphone
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

/** The codex guest: a module two orders of magnitude larger than anything else on the page.
 * Whether WebKit compiles and instantiates it at all is the first question. */
async function runCodex(profile: string, options: BrowserContextOptions, touch: boolean): Promise<Check[]> {
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
  page.on("crash", () => errors.push("the page crashed"));
  const rss = () => {
    // Resident memory of every process of this browser, as a rough ceiling on what the page costs.
    try {
      const out = Bun.spawnSync(["bash", "-c", "ps -eo rss,args | grep -i -E 'WPEWebProcess|WPENetworkProcess|MiniBrowser|pw_run' | grep -v grep | awk '{s+=$1} END {print s}'"]).stdout.toString().trim();
      return Math.round(Number(out) / 1024);
    } catch {
      return 0;
    }
  };
  try {
    const before = rss();
    const started = Date.now();
    await page.goto(`${base}/?guest=codex&persist=0`);
    let indicator = "";
    const up = await (async () => {
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline) {
        const state = await page.evaluate(() => ({ label: document.querySelector("#loading.shown .label")?.textContent ?? "", exit: window.wasmTerm?.exit ?? null, up: !!window.wasmTerm?.screen().join("").trim(), fatal: document.querySelector("#fatal")?.textContent ?? "" })).catch(() => null);
        if (state?.label) indicator = state.label;
        if (state?.up || state?.exit || state?.fatal) return state;
        await page.waitForTimeout(100);
      }
      return null;
    })();
    const load = await page.evaluate(() => window.wasmTerm?.load).catch(() => undefined);
    check(`codex: the module downloads, compiles and starts (${JSON.stringify(load)}, first output after ${Date.now() - started} ms)`, up?.up && !up.exit, { up, indicator, errors: errors.slice(0, 3) });
    // The indicator appears 300 ms after the page starts and goes with the first output: from loopback, with the
    // compiled module arriving in a third of a second, there may be no moment at which a 100 ms poll can see it.
    const quick = Date.now() - started < 1500;
    check(`codex: loading indicator shown meanwhile (last label: "${indicator}"${indicator === "" && quick ? "; started too quickly to observe" : ""})`, indicator !== "" || quick, indicator);
    const home = await waitFor(page, "Ask Codex", 60_000).then(() => true, () => false);
    check("codex: start screen renders", home, (await screen(page)).split("\n").filter(Boolean).slice(-6));
    const connected = await waitFor(page, "mock-model default · /tmp/wasm-term-", 30_000).then(() => true, () => false);
    check("codex: connected to the app-server through the same-origin WebSocket relay (model and directory shown)", connected, (await screen(page)).split("\n").filter(Boolean).slice(-4));
    check(`codex: browser processes' resident memory ${before} MB before, ${rss()} MB with codex running`, true);
    const renderer = await page.evaluate(() => window.wasmTerm?.terminal.renderer?.constructor.name ?? "none");
    check(`codex: renderer in use: ${renderer}; grid ${await page.evaluate(() => `${window.wasmTerm.terminal.cols}x${window.wasmTerm.terminal.rows}`)}`, true);

    const key = (name: string) => page.locator(`.terminal-keys [data-key="${name}"]`).tap();
    if (touch) await key("Keyboard");
    else await page.evaluate(() => window.wasmTerm.terminal.focus());
    await page.waitForTimeout(300);
    await page.keyboard.type("hello there", { delay: 15 });
    const typed = await waitFor(page, "› hello there", 5_000).then(() => true, () => false);
    check("codex: typed text appears in the composer", typed, await page.evaluate(() => window.wasmTerm.sent.slice(-5)));
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    // The reply wraps differently at every width: its first words and the turn footer are enough.
    const replied = await waitFor(page, "Hello from mock-llm", 30_000).then(() => waitFor(page, "Worked for", 15_000)).then(() => true, () => false);
    check("codex: the prompt is answered, streamed over the WebSocket", replied, (await screen(page)).split("\n").filter(Boolean).slice(-8));
    await page.waitForTimeout(500);

    if (touch) {
      const composer = async () => (await screen(page)).split("\n").filter(line => line.includes("›")).pop() ?? "";
      await key("ArrowUp");
      await page.waitForTimeout(500);
      check("codex, keys row: arrow up recalls the previous prompt", (await composer()).includes("hello there"), await composer());
      await key("ShiftEnter");
      await page.keyboard.type("second line", { delay: 15 });
      await page.waitForTimeout(400);
      const lines = (await screen(page)).split("\n");
      const first = lines.findLastIndex(line => line.includes("› hello there")); // the composer, below the transcript's echo
      check("codex, keys row: shift+enter starts a new line in the prompt instead of submitting", first >= 0 && lines.slice(first + 1, first + 3).some(line => line.trim() === "second line"), lines.slice(first, first + 3));
      await key("Control");
      await page.keyboard.type("c");
      await page.waitForTimeout(500);
      check("codex, keys row: Ctrl then c clears the prompt", !(await screen(page)).includes("second line"), await composer());
      await page.keyboard.type("/", { delay: 15 });
      const popup = await page.waitForFunction(() => /\/permissions\s{2,}/.test(window.wasmTerm.screen().join("\n")), null, { timeout: 5_000 }).then(() => true, () => false);
      check("codex: typing / opens the slash-command popup", popup, (await screen(page)).split("\n").filter(Boolean).slice(-8));
      await key("ArrowDown");
      await page.waitForTimeout(300);
      await key("Escape");
      await page.waitForTimeout(600);
      check("codex, keys row: Esc closes the popup", !/\/permissions\s{2,}/.test(await screen(page)), (await screen(page)).split("\n").filter(Boolean).slice(-6));
      await key("Control");
      await page.keyboard.type("c");
      await page.waitForTimeout(300);
    }
    await page.screenshot({ path: join(shots, `webkit-${profile}-codex.png`) });
    await page.keyboard.type("/quit", { delay: 15 });
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    const exit = await page.waitForFunction(() => window.wasmTerm.exit, null, { timeout: 15_000 }).then(handle => handle.jsonValue(), () => null);
    check("codex: /quit ends the program with code 0", exit?.code === 0, exit);
    check("codex: no page errors", errors.length === 0, errors.slice(0, 5));
  } catch (error) {
    check("codex: the script ran to the end", false, { error: String((error as Error).stack ?? error).slice(0, 500), errors: errors.slice(0, 5) });
    await page.screenshot({ path: join(shots, `webkit-${profile}-codex.png`) }).catch(() => {});
  }
  await browser.close();
  return checks;
}

/** Child processes on WebKit: the `proc` guest's own checks (shell Workers, SharedArrayBuffer channels, stdin, kills),
 * then codex-local taking a turn whose tool calls run in the shell. */
async function runShell(profile: string, options: BrowserContextOptions, touch: boolean, guests: string[]): Promise<Check[]> {
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
  page.on("crash", () => errors.push("the page crashed"));
  interface ProcResult { failed: number; checks: { name: string; ok: boolean; detail: string }[]; numbers: Record<string, unknown> }
  const procRun = async (query: string): Promise<ProcResult | null> => {
    await page.goto(`${base}/?guest=proc&persist=0${query}`);
    await page.waitForFunction(() => window.wasmTerm?.exit, null, { timeout: 120_000 }).catch(() => {});
    return page.evaluate(async () => {
      try { return JSON.parse((await window.wasmTerm.readFile("/home/user/proc-result.json")) ?? ""); } catch { return null; }
    });
  };
  try {
    if (guests.includes("proc")) {
      for (const [label, query] of [["shell Workers", "&shell=worker"], ["inline", "&shell=inline&arg=inline&arg=quick"]] as const) {
        const result = await procRun(query);
        const bad = result?.checks.filter(item => !item.ok) ?? [];
        check(`proc (${label}): ${result?.checks.length ?? 0} checks of child processes pass`, result && result.failed === 0 && result.checks.length >= 15, { bad, exit: await page.evaluate(() => window.wasmTerm?.exit).catch(() => null), errors: errors.slice(0, 3) });
        if (result && label === "shell Workers") {
          const pick = (name: string) => JSON.stringify(result.numbers[name]);
          check(`proc numbers: \`echo hi\` ${pick("`echo hi`: spawn to exit event, ms")}; grep -rn over 2,000 files ${pick("`grep -rn NEEDLE tree | wc -l` over 2,000 files, 6.5 MB: spawn to exit event, ms")}; busy-loop kill ${pick("kill of `while :; do :; done`: ms from kill to exit event")} ms`, true);
        }
      }
    }
    if (guests.includes("codex-local")) {
      await page.goto(`${base}/?guest=codex-local&persist=0`);
      const home = await waitFor(page, "Ask Codex", 240_000).then(() => true, () => false);
      check("codex-local: the module starts and shows its start screen", home, { tail: (await screen(page)).split("\n").filter(Boolean).slice(-6), errors: errors.slice(0, 3) });
      const key = (name: string) => page.locator(`.terminal-keys [data-key="${name}"]`).tap();
      if (touch) await key("Keyboard");
      else await page.evaluate(() => window.wasmTerm.terminal.focus());
      await page.waitForTimeout(500);
      const turn = async (prompt: string, done: string) => {
        await page.keyboard.type(prompt, { delay: 15 });
        await page.waitForTimeout(300);
        await page.keyboard.press("Enter");
        return waitFor(page, done, 60_000).then(() => waitFor(page, "Worked for", 15_000)).then(() => true, () => false);
      };
      const read = await turn("shell-read", "MOCK-SHELL-READ-DONE");
      const procs = await page.evaluate(() => window.wasmTerm.program.procs);
      check("codex-local: a turn of six shell commands (rg --files, rg -n, nl -ba | sed -n, sed -n, cat, ls -la) all exit 0", read && procs.length === 6 && procs.every(proc => proc.status === 0), { procs, tail: (await screen(page)).split("\n").filter(Boolean).slice(-12) });
      const flat = (await screen(page)).replace(/\n\s*/g, " ");
      check("codex-local: the model got the commands' output (first lines of rg and cat)", /2\. exit 0: src\/inventory\.py:\d+:def load_items/.test(flat) && /5\. exit 0: name,quantity,unit_price/.test(flat), flat.slice(-900));
      const fix = await turn("shell-fix", "MOCK-SHELL-FIX-DONE");
      check("codex-local: read, apply_patch, verify with the shell", fix && /sorted\(items/.test((await page.evaluate(() => window.wasmTerm.readFile("/home/user/project/src/report.py"))) ?? ""), (await screen(page)).split("\n").filter(Boolean).slice(-10));
      const all = await page.evaluate(() => window.wasmTerm.program.procs);
      const rg = all.filter(proc => /-lc rg /.test(proc.command));
      check(`codex-local numbers: ${all.length} commands, waiting for a shell ${Math.max(...all.map(proc => proc.queueMs)).toFixed(2)} ms at most, rg ${rg.map(proc => (proc.queueMs + proc.runMs).toFixed(2)).join(" / ")} ms`, true);
      await page.screenshot({ path: join(shots, `webkit-${profile}-codex-local-shell.png`) });
      // The relay refuses hosts it does not know (codex asks GitHub for an announcement): a 403 in the console, by design.
      const real = errors.filter(error => !/status of 403/.test(error));
      check("codex-local: no page errors", real.length === 0, real.slice(0, 5));
    }
  } catch (error) {
    check("shell: the script ran to the end", false, { error: String((error as Error).stack ?? error).slice(0, 500), errors: errors.slice(0, 5) });
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
  const guests = (process.env.GUESTS ?? "opencode,codex,proc,codex-local").split(",");
  const results = [
    ...(guests.includes("opencode") ? await run(profile, options, touch) : []),
    ...(guests.includes("codex") ? await runCodex(profile, options, touch) : []),
    ...(guests.includes("proc") || guests.includes("codex-local") ? await runShell(profile, options, touch, guests) : []),
  ];
  for (const item of results) {
    if (!item.ok) failed++;
    console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name}${item.ok ? "" : `: ${JSON.stringify(item.detail)}`}`);
  }
}
process.exit(failed ? 1 : 0);
