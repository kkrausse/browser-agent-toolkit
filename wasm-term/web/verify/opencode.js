// Drives the opencode TUI guest on the dev page in a real browser, against the
// containerised backend (mock-llm/up.sh), and compares what it shows with the
// native client's captures (mock-llm/baseline/opencode-*.txt and
// baseline/opencode-markdown.json here). Run through ./run.sh opencode, which
// supplies BASE, SHOTS and ROOT (absolute, because the browser-control relay
// has its own working directory).
//
// Returns { passed, failed, failures, checks }. Screenshots go to docs/screenshots/.

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: ok ? undefined : detail });

const rows = async () => page.evaluate(() => window.wasmTerm.screen());
const text = async () => (await rows()).join("\n");
const type = async (value) => { await page.keyboard.type(value, { delay: 5 }); await page.waitForTimeout(150); };
const press = async (key, pause = 300) => { await page.keyboard.press(key); await page.waitForTimeout(pause); };
const waitFor = (needle, timeout = 20000) =>
  page.waitForFunction((value) => window.wasmTerm?.screen().join("\n").includes(value), needle, { timeout });
const waitGone = (needle, timeout = 10000) =>
  page.waitForFunction((value) => !window.wasmTerm.screen().join("\n").includes(value), needle, { timeout });
const exited = () => page.evaluate(() => window.wasmTerm.exit);
const focus = () => page.evaluate(() => window.wasmTerm.terminal.focus());
const metrics = () => page.evaluate(() => { const m = window.wasmTerm.terminal.renderer.getMetrics(); return [m.width, m.height]; });
const cell = async (col, row) => { const [w, h] = await metrics(); return [col * w + w / 2, row * h + h / 2]; };
const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png` });
const size = () => page.evaluate(() => [window.wasmTerm.terminal.cols, window.wasmTerm.terminal.rows]);
/** Sizes the window so the terminal is exactly cols x rows (the native captures' sizes). */
const setTerminalSize = async (cols, rows) => {
  const [w, h] = await metrics();
  await page.setViewportSize({ width: Math.ceil(cols * w), height: Math.ceil(rows * h) + 1 });
  await page.waitForFunction(([c, r]) => window.wasmTerm.terminal.cols === c && window.wasmTerm.terminal.rows === r, [cols, rows], { timeout: 5000 });
  await page.waitForTimeout(400);
};
const paste = (value) => page.evaluate((value) => {
  const data = new DataTransfer();
  data.setData("text/plain", value);
  document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}, value);
/** Position of the first occurrence of `needle` on screen: [col, row]. */
const find = async (needle) => {
  const all = await rows();
  const row = all.findIndex(line => line.includes(needle));
  return row < 0 ? null : [all[row].indexOf(needle), row];
};
const prompt = async (value) => { await type(value); await press("Enter"); };

// A capture reduced to what must be identical between the native client and
// the browser: no blank lines, tab bar, spinner frames, timings or token counts.
const normalize = (screen) => screen.split("\n")
  .filter(line => line.trim() !== "" && !/Mock session.*\+$/.test(line.trimEnd()))
  .map(line => line.trimEnd()
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "*")
    .replace(/· [\d.]+m?s · [\d.]+ tok\/s/, "· TIME · TPS")
    .replace(/\s+[\d.]+K \(\d+%\)\s+/, "  USAGE  "));
const baseline = (name) => normalize(fs.readFileSync(`${ROOT}/mock-llm/baseline/${name}.txt`, "utf8"));
const sameLines = (name, actual, expected) => {
  const got = normalize(actual);
  const missing = expected.filter(line => !got.includes(line));
  check(name, missing.length === 0 && got.length === expected.length,
    { missing, extra: got.filter(line => !expected.includes(line)), lines: [got.length, expected.length] });
};

let startMs = 0;
try {
// ---- the launcher ------------------------------------------------------------
await page.setViewportSize({ width: 1200, height: 800 });
await page.goto(`${BASE}/`);
await page.waitForSelector('form input[name="guest"][value="opencode"]', { state: "attached" });
const defaults = await page.evaluate(() => {
  const form = document.querySelector('input[name="guest"][value="opencode"]').form;
  return Object.fromEntries([...new FormData(form)]);
});
check("launcher lists opencode with the mock backend's defaults",
  defaults.server === "/proxy/opencode" && defaults.password === "wasm-term-mock" && defaults.dir === "/tmp/wasm-term-workspace", defaults);
check("launcher lists the wasm guests too", await page.evaluate(() => !!document.querySelector('input[name="guest"][value="repl"]')));
await shot("opencode-launcher");
await page.evaluate(() => {
  const form = document.querySelector('input[name="guest"][value="opencode"]').form;
  form.insertAdjacentHTML("beforeend", '<input type="hidden" name="reset" value="1">'); // start from no saved state
  form.requestSubmit();
});

// ---- connect -------------------------------------------------------------------
const started = Date.now();
await page.waitForFunction(() => window.wasmTerm?.screen().join("\n").includes("Ask anything"), null, { timeout: 30000 });
startMs = Date.now() - started;
check("launcher form starts the guest with its settings in the URL", /guest=opencode&server=.*&password=.*&dir=/.test(page.url()), page.url());
await focus();
await setTerminalSize(110, 36);
const home = await text();
check("connected: model and project directory from the server are shown", home.includes("Mock Model") && home.includes("/tmp/wasm-term-workspace:master"), home.split("\n").filter(Boolean).slice(-4));
check("alternate screen, mouse tracking, bracketed paste and focus reports requested", await page.evaluate(() => {
  const t = window.wasmTerm.terminal;
  return t.buffer.active.type === "alternate" && t.hasMouseTracking() && t.hasBracketedPaste() && t.hasFocusEvents();
}));
await shot("opencode-home");

// ---- plain prompt, streamed reply ------------------------------------------------
await prompt("hello there");
await waitFor("no tokens were spent");
await waitFor("tok/s");
sameLines("plain prompt: screen equals the native capture (opencode-plain.txt)", await text(), baseline("opencode-plain"));
await shot("opencode-plain");

// ---- tool call with the permission dialog -----------------------------------------
await prompt("please use a tool");
await waitFor("Permission required");
await waitFor("enter confirm");
sameLines("tool call: permission dialog equals the native capture (opencode-tool-permission.txt)", await text(), baseline("opencode-tool-permission"));
await shot("opencode-permission");
await press("Enter");
await waitFor("MOCK-TOOL-DONE");
await waitFor("TIME", 100).catch(() => {});
await page.waitForFunction(() => (window.wasmTerm.screen().join("\n").match(/tok\/s/g) ?? []).length === 2, null, { timeout: 10000 });
sameLines("tool call: after Allow once, output and final answer equal the native capture (opencode-tool.txt)", await text(), baseline("opencode-tool"));
await shot("opencode-tool");

// ---- command palette, new session ---------------------------------------------------
await press("Control+p");
await waitFor("Commands");
check("command palette opens on ctrl+p (kitty keyboard sequence)", (await text()).includes("Switch model"));
await type("new session");
await waitFor("ctrl+x n");
await shot("opencode-palette");
const entry = await find("New session");
await page.mouse.click(...(await cell(entry[0] + 2, entry[1])));
await waitFor("Ask anything");
check("mouse: clicking a palette entry runs it (new session, empty transcript)", !(await text()).includes("MOCK-TOOL-DONE"));

// ---- markdown and syntax highlighting -------------------------------------------------
await setTerminalSize(120, 47);
check("resize: the program sees the new window size", JSON.stringify(await size()) === "[120,47]" && (await rows()).some(line => line.length > 112), await size());
await prompt("show me markdown");
await waitFor("End of the markdown scenario.");
await waitFor("tok/s");
await page.waitForTimeout(1500); // highlights arrive from the tree-sitter worker after the text
const expectedMarkdown = JSON.parse(fs.readFileSync(`${ROOT}/web/verify/baseline/opencode-markdown.json`, "utf8")).rows;
const styled = await page.evaluate(() => {
  const terminal = window.wasmTerm.terminal;
  const buffer = terminal.buffer.active;
  const out = [];
  for (let y = 0; y < terminal.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    const runs = [];
    let end = -1;
    for (let x = 0; x < terminal.cols; x++) {
      const c = line.getCell(x);
      const chars = c?.getChars() ?? "";
      if (!chars || chars === " ") continue;
      const key = c.getFgColor().toString(16).padStart(6, "0") + (c.isBold() ? "b" : "") + (c.isItalic() ? "i" : "");
      const last = runs[runs.length - 1];
      if (last && last[1] === key && end === x) last[2] += chars;
      else runs.push([x, key, chars]);
      end = x + Math.max(1, c.getWidth());
    }
    out.push({ text: line.translateToString(true), runs });
  }
  return out;
});
const first = styled.findIndex(row => row.text.includes("Scripted markdown"));
const block = styled.slice(first, first + expectedMarkdown.length);
check("markdown: markup is concealed, text equals the native client's", first >= 0 && block.every((row, i) => row.text === expectedMarkdown[i].text),
  block.map(row => row.text).filter((line, i) => line !== expectedMarkdown[i]?.text));
const styleDiffs = block.flatMap((row, i) => JSON.stringify(row.runs) === JSON.stringify(expectedMarkdown[i].runs) ? [] : [{ row: row.text, got: row.runs, want: expectedMarkdown[i].runs }]);
check("markdown + syntax highlighting: every cell's colour, bold and italic equal the native client's", first >= 0 && styleDiffs.length === 0, styleDiffs.slice(0, 3));
await shot("opencode-markdown");

// ---- long reply, scrolling ----------------------------------------------------------------
await prompt("long scroll");
const steps = new Set();
for (let i = 0; i < 400 && !(await text()).includes("END-OF-LONG-RESPONSE"); i++) {
  steps.add((await rows()).filter(line => /^ {5}\S/.test(line)).join("\n"));
  await page.waitForTimeout(50);
}
check("streaming: the long reply grew on screen in many steps while it arrived (SSE)", steps.size >= 10, steps.size);
await waitFor("END-OF-LONG-RESPONSE", 40000);
await waitFor("tok/s");
const bottom = await text();
await page.mouse.move(...(await cell(40, 15)));
for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(40); }
await page.waitForTimeout(500);
const scrolled = await text();
check("long reply: mouse wheel scrolls the transcript back", !scrolled.includes("END-OF-LONG-RESPONSE") && scrolled !== bottom, scrolled.split("\n").slice(0, 6));
await shot("opencode-long-scrolled");
for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 240); await page.waitForTimeout(20); }
await waitFor("END-OF-LONG-RESPONSE", 5000);
check("long reply: scrolling forward returns to the end", true);

// ---- paste and clipboard ---------------------------------------------------------------------
await paste("pasted via the paste event");
await waitFor("pasted via the paste event", 5000);
check("paste: the browser's paste event arrives as a bracketed paste", (await page.evaluate(() => window.wasmTerm.sent.slice(-3))).some(data => data === "\x1b[200~pasted via the paste event\x1b[201~"));
// The Worker has no clipboard API: ctrl+v reaches the program as a key, the
// program asks the machine, the page answers. Chrome cannot grant the
// clipboard-read prompt under automation, so the page's clipboard object is
// replaced; everything between it and the TUI is the real path.
const realWrite = await page.evaluate(async () => {
  window.__copied = [];
  const real = window.wasmTerm.clipboard;
  let outcome = "not called";
  window.__realWrite = () => outcome;
  window.wasmTerm.clipboard = {
    readText: async () => " + read through the bridge",
    writeText: async (value) => { window.__copied.push(value); await real.writeText(value).then(() => (outcome = "ok"), error => (outcome = String(error))); },
  };
});
await press("Control+v");
await waitFor("+ read through the bridge", 5000);
check("clipboard read: ctrl+v is sent as a key (CSI 118;5u), the TUI pastes what the page's clipboard returns",
  (await page.evaluate(() => window.wasmTerm.sent.slice(-2))).includes("\x1b[118;5u"));
for (let i = 0; i < 60; i++) await page.keyboard.press("Backspace");
await page.waitForTimeout(300);
const target = await find("END-OF-LONG-RESPONSE");
await page.mouse.move(...(await cell(target[0], target[1])));
await page.mouse.down();
await page.mouse.move(...(await cell(target[0] + 20, target[1])), { steps: 6 });
await page.mouse.up();
await page.waitForFunction(() => window.__copied.length > 0, null, { timeout: 5000 }).catch(() => {});
const copied = await page.evaluate(() => [window.__copied, window.__realWrite()]);
check("clipboard write: selecting transcript text with the mouse copies it to the page's clipboard", copied[0].some(value => value.includes("END-OF-LONG-RESPONSE")) && copied[1] === "ok", copied);
await press("Escape");

// ---- session list and switch --------------------------------------------------------------------
await page.keyboard.press("Control+x"); await press("l", 800);
await waitFor("Sessions for");
await shot("opencode-sessions");
await press("ArrowDown"); await press("Enter", 800);
await waitFor("MOCK-TOOL-DONE");
check("session switch: the previous session's transcript is shown", (await text()).includes("please use a tool") && !(await text()).includes("END-OF-LONG-RESPONSE"));

// ---- persistence across a reload ---------------------------------------------------------------------
const background = () => page.evaluate(() => {
  const buffer = window.wasmTerm.terminal.buffer.active;
  return buffer.getLine(buffer.viewportY + 2).getCell(100).getBgColor().toString(16);
});
const defaultBackground = await background();
await press("Control+p"); await type("switch theme"); await press("Enter", 600);
await waitFor("Themes");
await type("dracula"); await press("Enter", 800);
check("settings: the theme picker changes the theme", (await background()) !== defaultBackground, [defaultBackground, await background()]);
await page.waitForTimeout(500);
await page.goto(`${BASE}/?guest=opencode`);
await waitFor("Mock Model", 30000);
await focus();
await page.waitForTimeout(800);
const stored = await page.evaluate(() => new Promise((resolve) => {
  const request = indexedDB.open("wasm-term");
  request.onsuccess = () => {
    const keys = request.result.transaction("files").objectStore("files").getAllKeys();
    keys.onsuccess = () => resolve(keys.result.map(String).filter(key => key.startsWith("opencode\n")).map(key => key.slice(9)));
  };
}));
check("persistence: the client's state directory is in IndexedDB", stored.some(path => path.endsWith("/prompt-history.jsonl")) && stored.every(path => !path.includes("/locks/")), stored);
const restored = await text();
check("persistence: after a reload the open sessions are restored (tabs.json)", restored.includes("MOCK-TOOL-DONE") || restored.includes("Mock session"), restored.split("\n").filter(Boolean).slice(0, 5));
await press("Control+x"); await press("n", 800);
await waitFor("Ask anything");
await press("ArrowUp");
check("persistence: the chosen theme survives the reload (cli.json): dracula's background", (await background()) === "282a36" && stored.some(path => path.endsWith("/opencode/cli.json")), await background());
check("persistence: prompt history survives the reload", /long scroll|show me markdown|please use a tool/.test(await text()), (await rows()).filter(line => line.includes("┃")));
await press("Control+c");

// ---- exit -------------------------------------------------------------------------------------------------
await press("Control+c");
await page.waitForFunction(() => window.wasmTerm.exit !== null, null, { timeout: 10000 }).catch(() => {});
const status = await exited();
const after = await page.evaluate(() => ({ buffer: window.wasmTerm.terminal.buffer.active.type, mouse: window.wasmTerm.terminal.hasMouseTracking() }));
check("exit: ctrl+c ends the program with code 0, alternate screen left, mouse tracking off", status?.code === 0 && after.buffer === "normal" && !after.mouse, { status, after });
await shot("opencode-exit");

// Leave no saved state behind: the next person to open the page gets the defaults.
await page.evaluate(() => new Promise((resolve) => {
  const request = indexedDB.open("wasm-term");
  request.onsuccess = () => {
    const transaction = request.result.transaction("files", "readwrite");
    transaction.objectStore("files").delete(IDBKeyRange.bound("opencode\n", "opencode\n\uffff"));
    transaction.oncomplete = resolve;
  };
}));
} catch (error) {
  check("the script ran to the end", false, String(error?.stack ?? error).slice(0, 600));
}
await page.setViewportSize({ width: 1200, height: 800 });
const failed = checks.filter(item => !item.ok);
return { passed: checks.length - failed.length, failed: failed.length, startMs, failures: failed.map(item => `${item.name}: ${JSON.stringify(item.detail)}`), checks: checks.map(item => `${item.ok ? "PASS" : "FAIL"} ${item.name}`) };
