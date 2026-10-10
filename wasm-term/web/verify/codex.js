// Drives the codex TUI guest (the real Rust TUI, wasm32-wasip1) on the dev page
// in a real browser, against the containerised backend (mock-llm/up.sh), and
// compares what it shows with the native client's captures
// (mock-llm/baseline/codex-*.txt). Run through ./run.sh codex, which supplies
// BASE, SHOTS and ROOT.
//
// Returns { passed, failed, failures, checks }. Screenshots go to docs/screenshots/.

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: ok ? undefined : detail });

const rows = async () => page.evaluate(() => window.wasmTerm.screen());
const text = async () => (await rows()).join("\n");
/** The whole buffer. codex 0.162 owns the screen (alternate buffer, its own transcript scrolling), so this
 * is normally just the screen; after exit it is the normal buffer with what the program left there. */
const history = () => page.evaluate(() => {
  const buffer = window.wasmTerm.terminal.buffer.active;
  const lines = [];
  for (let row = 0; row < buffer.length; row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
  return lines.join("\n");
});
// 12 ms apart: quick typing, but not what codex's paste detector takes for a paste (8 ms between characters).
const type = async (value) => { await page.keyboard.type(value, { delay: 12 }); await page.waitForTimeout(250); };
const press = async (key, pause = 300) => { await page.keyboard.press(key); await page.waitForTimeout(pause); };
const waitFor = (needle, timeout = 20000) =>
  page.waitForFunction((value) => window.wasmTerm?.screen().join("\n").includes(value), needle, { timeout });
const exited = () => page.evaluate(() => window.wasmTerm.exit);
const focus = () => page.evaluate(() => window.wasmTerm.terminal.focus());
const metrics = () => page.evaluate(() => { const m = window.wasmTerm.terminal.renderer.getMetrics(); return [m.width, m.height]; });
const cell = async (col, row) => { const [w, h] = await metrics(); return [col * w + w / 2, row * h + h / 2]; };
// In front first: a tab behind another one in the shared browser produces no frames, and a screenshot of a static page then never completes.
const shot = async (name) => { await page.bringToFront(); return page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const size = () => page.evaluate(() => [window.wasmTerm.terminal.cols, window.wasmTerm.terminal.rows]);
const setTerminalSize = async (cols, rows) => {
  const [w, h] = await metrics();
  await page.setViewportSize({ width: Math.ceil(cols * w), height: Math.ceil(rows * h) + 1 });
  await page.waitForFunction(([c, r]) => window.wasmTerm.terminal.cols === c && window.wasmTerm.terminal.rows === r, [cols, rows], { timeout: 5000 });
  await page.waitForTimeout(500);
};
const paste = (value) => page.evaluate((value) => {
  const data = new DataTransfer();
  data.setData("text/plain", value);
  document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}, value);
const prompt = async (value) => { await type(value); await press("Enter"); };
/** A turn is over when its "Worked for ..." line is below the prompt's echo and nothing is running any more.
 * (A long reply scrolls the echo off; then any "Worked for" on a quiet screen is this turn's.) */
const turnDone = (value, timeout = 30000) => page.waitForFunction((value) => {
  const screen = window.wasmTerm.screen().join("\n");
  if (/esc to interrupt/.test(screen) || !screen.includes("Ask Codex to do anything")) return false;
  const echo = screen.lastIndexOf(`› ${value}`);
  return /Worked for /.test(echo < 0 ? screen : screen.slice(echo));
}, value, { timeout });
/** Sends a prompt and waits until its turn has finished. */
const turn = async (value, timeout = 30000) => {
  await prompt(value);
  await page.waitForTimeout(500);
  await turnDone(value, timeout);
  await page.waitForTimeout(400);
};
const start = async (query = "") => {
  await page.goto(`${BASE}/?guest=codex${query}`);
  await waitFor("Ask Codex", 120000);
  // The session is usable once the server's thread exists: the header shows the project directory.
  await waitFor("/tmp/wasm-term-workspace", 30000);
  await focus();
  await page.waitForTimeout(600);
};

// A capture reduced to what must be identical between the native client and
// the browser: no blank lines, times, the two captures' older workspace path,
// the tool result's byte count (it contains the path).
const normalize = (screen) => screen.split("\n")
  .filter(line => line.trim() !== "")
  .map(line => line.trimEnd()
    .replace(/(~|\/home\/\w+)\/devfs\/repos\/[\w/.-]*\.state\/workspace/, "/tmp/wasm-term-workspace")
    .replace(/Worked for <?\d+m?s • \d+:\d+ [AP]M/, "Worked for TIME")
    .replace(/Tool result received \(\d+ chars\)/, "Tool result received (N chars)")
    .replace(/\s+⚠ 1 warning · f2 to view$/, "  WARNING")
    .replace(/· [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/, "").trimEnd());
const baseline = (name) => normalize(fs.readFileSync(`${ROOT}/mock-llm/baseline/${name}.txt`, "utf8"));
/** Every line of the native capture, in order, somewhere in what the browser shows (its screen plus scrollback). */
const containsInOrder = (name, actual, expected) => {
  const got = normalize(actual);
  let at = 0;
  const missing = [];
  for (const line of expected) {
    const found = got.indexOf(line, at);
    if (found < 0) missing.push(line);
    else at = found + 1;
  }
  check(name, missing.length === 0, { missing, got: got.slice(-expected.length - 4) });
};

let startMs = 0;
let load = null;
try {
// ---- the launcher ------------------------------------------------------------
await page.setViewportSize({ width: 1200, height: 800 });
await page.goto(`${BASE}/`);
await page.waitForSelector('form input[name="guest"][value="codex"]', { state: "attached" });
const defaults = await page.evaluate(() => Object.fromEntries([...new FormData(document.querySelector('input[name="guest"][value="codex"]').form)]));
check("launcher lists codex with the mock backend's defaults",
  defaults.remote === "/proxy/codex" && defaults.dir === "/tmp/wasm-term-workspace" && defaults.sandbox === "danger-full-access", defaults);
await shot("codex-launcher");

// ---- how the module is served ---------------------------------------------------
const served = await page.evaluate(async () => {
  const guest = (await (await fetch("/guests.json")).json()).find(entry => entry.name === "codex");
  const response = await fetch(guest.module, { cache: "no-store" });
  await response.body.cancel();
  const header = name => response.headers.get(name);
  return { module: guest.module, status: response.status, type: header("content-type"), encoding: header("content-encoding"), cache: header("cache-control"), size: Number(header("x-wasm-term-size")), transfer: Number(header("content-length")) };
});
check("module: content-hashed URL, application/wasm, precompressed (br or gzip), immutable caching",
  /\/guests\/codex\/codex-[0-9a-f]{16}\.wasm$/.test(served.module) && served.status === 200 && served.type === "application/wasm"
    && ["br", "gzip"].includes(served.encoding) && /immutable/.test(served.cache) && served.size > 1e6, served);

await page.evaluate(() => {
  const form = document.querySelector('input[name="guest"][value="codex"]').form;
  form.insertAdjacentHTML("beforeend", '<input type="hidden" name="reset" value="1">'); // start from no saved state
  form.requestSubmit();
});

// ---- load, connect -------------------------------------------------------------
const started = Date.now();
let indicator = null;
for (let i = 0; i < 400; i++) {
  const state = await page.evaluate(() => ({ shown: document.querySelector("#loading")?.classList.contains("shown"), label: document.querySelector("#loading .label")?.textContent, up: !!window.wasmTerm?.screen().join("").trim() })).catch(() => null);
  if (state?.shown && /Loading codex|Compiling codex|Starting codex/.test(state.label)) indicator = indicator ?? state.label;
  if (state?.up) break;
  await page.waitForTimeout(25);
}
await waitFor("Ask Codex", 120000);
startMs = Date.now() - started;
load = await page.evaluate(() => window.wasmTerm.load);
check("loading indicator was visible while the module arrived and compiled", indicator !== null, { indicator, load });
check("loading indicator is gone once the program draws", await page.evaluate(() => !document.querySelector("#loading").classList.contains("shown")));
check("launcher form starts the guest with its settings in the URL", /guest=codex&remote=.*&dir=.*&sandbox=danger-full-access/.test(page.url()), page.url());
await waitFor("/tmp/wasm-term-workspace", 30000);
await focus();
await setTerminalSize(110, 40);
await page.waitForTimeout(800);
const home = await text();
check("connected through the page's own origin (/proxy/codex): model and project directory from the server",
  home.includes("mock-model default · /tmp/wasm-term-workspace") && home.includes("OpenAI Codex (v0.162.0)"), home.split("\n").filter(Boolean).slice(-4));
containsInOrder("start screen: banner and command hints equal the native capture", home, baseline("codex-plain").slice(0, 8).filter(line => !line.includes("›")));
const replies = await page.evaluate(() => window.wasmTerm.sent.join(""));
check("startup probe: the terminal answered the cursor, default-colour (OSC 10/11) and keyboard queries",
  /\x1b\[\d+;\d+R/.test(replies) && /\x1b\]10;rgb:/.test(replies) && /\x1b\]11;rgb:/.test(replies) && /\x1b\[\?\d+u/.test(replies), JSON.stringify(replies).slice(0, 300));
await shot("codex-home");

// ---- plain prompt, streamed reply ------------------------------------------------
await turn("hello there");
containsInOrder("plain prompt: equals the native capture (codex-plain.txt)", await history(), baseline("codex-plain"));
const footer = (await rows()).find(line => /Worked for /.test(line)) ?? "";
const clock = await page.evaluate(() => new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));
const minutes = (value) => { const m = /(\d+):(\d+) ([AP]M)/.exec(value); return m ? (Number(m[1]) % 12 + (m[3] === "PM" ? 12 : 0)) * 60 + Number(m[2]) : -99; };
check("time zone: the turn footer shows the browser's local time", Math.abs(minutes(footer) - minutes(clock)) <= 1 || Math.abs(minutes(footer) - minutes(clock)) >= 1439, { footer: footer.trim(), clock });
await shot("codex-plain");

// ---- tool call ---------------------------------------------------------------------
await turn("please use a tool");
containsInOrder("tool call: command, output and final answer equal the native capture (codex-tool.txt)", await history(), baseline("codex-tool"));
await shot("codex-tool");

// ---- markdown ------------------------------------------------------------------------
await turn("show me markdown");
const markdown = await history();
const from = markdown.lastIndexOf("show me markdown");
const rendered = markdown.slice(from);
check("markdown: emphasis, list, fenced code, table and quote are rendered, their markup is not shown",
  /End of the markdown scenario\./.test(rendered) && !/\*\*|```|\|/.test(rendered) && /━━━/.test(rendered) && /• nested bullet/.test(rendered), rendered.split("\n").filter(Boolean).slice(0, 30));
const styles = await page.evaluate(() => {
  const terminal = window.wasmTerm.terminal;
  const buffer = terminal.buffer.active;
  const colours = new Set();
  let bold = 0;
  for (let y = 0; y < terminal.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    for (let x = 0; x < terminal.cols; x++) {
      const c = line?.getCell(x);
      if (!c?.getChars()?.trim()) continue;
      colours.add(c.getFgColor());
      if (c.isBold()) bold++;
    }
  }
  return { colours: colours.size, bold };
});
check("markdown: the code block is syntax highlighted (several colours) and headings are bold", styles.colours >= 4 && styles.bold > 0, styles);
await shot("codex-markdown");

// ---- long reply, scrolling ----------------------------------------------------------------
await prompt("long scroll");
const steps = new Set();
for (let i = 0; i < 600 && !(await text()).includes("END-OF-LONG-RESPONSE"); i++) {
  steps.add((await rows()).filter(line => /line \d+/i.test(line)).length + ":" + (await rows()).filter(Boolean).pop());
  await page.waitForTimeout(50);
}
check("streaming: the long reply grew on screen in many steps while it arrived", steps.size >= 10, [...steps].slice(0, 12));
await turnDone("long scroll", 60000);
await page.waitForTimeout(500);
const bottom = await text();
await page.mouse.move(...(await cell(40, 15)));
for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(40); }
await page.waitForTimeout(500);
const scrolled = await text();
check("long reply: mouse wheel scrolls back through it", !scrolled.includes("END-OF-LONG-RESPONSE") && scrolled !== bottom && /line \d+/i.test(scrolled), scrolled.split("\n").slice(0, 6));
await shot("codex-long-scrolled");
for (let i = 0; i < 60; i++) { await page.mouse.wheel(0, 240); await page.waitForTimeout(20); }
await page.waitForFunction(() => window.wasmTerm.screen().join("\n").includes("END-OF-LONG-RESPONSE"), null, { timeout: 5000 }).catch(() => {});
check("long reply: scrolling forward returns to the end", (await text()).includes("END-OF-LONG-RESPONSE"), (await text()).split("\n").slice(-8));

// ---- resize ------------------------------------------------------------------------------------
await setTerminalSize(84, 30);
await page.waitForTimeout(600);
const narrow = await rows();
check("resize: the program sees the new window size and lays the screen out again",
  JSON.stringify(await size()) === "[84,30]" && narrow.every(line => line.length <= 84) && narrow.some(line => line.includes("mock-model default")), [await size(), narrow.filter(Boolean).slice(-3)]);
await shot("codex-resized");
await setTerminalSize(110, 40);

// ---- overlays -------------------------------------------------------------------------------------
await type("/");
await waitFor("/model", 5000).catch(() => {});
const popup = await text();
check("slash-command popup lists commands as soon as / is typed", /\/model\s+choose what model/.test(popup) && /\/permissions\s+choose what Codex/.test(popup), popup.split("\n").filter(Boolean).slice(-10));
await shot("codex-slash-popup");
await type("stat");
await press("Enter", 800);
await waitFor("Session", 8000).catch(() => {});
check("/status prints the session card (model, directory, sandbox)", /mock-model/.test(await text()) && /danger-full-access|Full Access|full access/i.test(await history()), (await text()).split("\n").filter(Boolean).slice(-16));
await shot("codex-status");
// codex 0.162 owns the whole screen (alternate buffer, mouse reporting): the transcript itself is the
// scrollable view, checked above. The warnings viewer is its overlay on top of that.
check("the program owns the screen: alternate buffer with mouse reporting", await page.evaluate(() => window.wasmTerm.terminal.buffer.active.type === "alternate" && window.wasmTerm.terminal.hasMouseTracking()));
await press("F2", 800);
const warnings = await text();
check("warnings viewer (f2) opens over the transcript", /Model metadata for .mock-model. not found/.test(warnings), warnings.split("\n").filter(Boolean).slice(0, 8));
await shot("codex-warnings");
await press("Escape", 800);
if (/Model metadata for .mock-model. not found/.test(await text())) await press("q", 800);
check("warnings viewer closes, back at the composer", (await text()).includes("mock-model default") && (await text()).includes("Ask Codex"), (await text()).split("\n").filter(Boolean).slice(-4));

// ---- paste ---------------------------------------------------------------------------------------
await paste("pasted via the paste event");
await waitFor("pasted via the paste event", 5000).catch(() => {});
check("paste: the browser's paste event arrives as a bracketed paste and lands in the composer",
  (await text()).includes("› pasted via the paste event") && (await page.evaluate(() => window.wasmTerm.sent.slice(-3))).some(data => data === "\x1b[200~pasted via the paste event\x1b[201~"), (await rows()).filter(line => line.includes("›")));
await press("Shift+Enter");
await type("second line");
const composer = await rows();
const first = composer.findIndex(line => line.includes("› pasted via the paste event"));
check("shift+enter inserts a newline in the composer (kitty keyboard protocol)", first >= 0 && composer[first + 1]?.trim() === "second line", composer.slice(first, first + 3));
await press("Control+c", 500);
check("ctrl+c clears the composer", !(await text()).includes("second line") || (await text()).includes("Ask Codex"), (await rows()).filter(line => line.includes("›")));

// ---- files and persistence ---------------------------------------------------------------------------
const files = await page.evaluate(() => window.wasmTerm.listFiles("/home/user"));
const historyFile = await page.evaluate(() => window.wasmTerm.readFile("/home/user/.codex/history.jsonl"));
check("debugging: wasmTerm.listFiles / readFile read the program's filesystem (config.toml, history.jsonl)",
  files.some(file => file.path === "/home/user/.codex/config.toml") && /long scroll/.test(historyFile ?? ""), files);
await page.waitForTimeout(500);
await start();
const stored = await page.evaluate(() => new Promise((resolve) => {
  const request = indexedDB.open("wasm-term");
  request.onsuccess = () => {
    const keys = request.result.transaction("files").objectStore("files").getAllKeys();
    keys.onsuccess = () => resolve(keys.result.map(String).filter(key => key.startsWith("codex\n")).map(key => key.slice(6)));
  };
}));
check("persistence: CODEX_HOME (config.toml, history.jsonl) is in IndexedDB, its scratch and log directories are not",
  stored.includes("/home/user/.codex/history.jsonl") && stored.includes("/home/user/.codex/config.toml") && stored.every(path => !/\/\.codex\/(tmp|log)\//.test(path)), stored);
await press("ArrowUp", 600);
const recalled = (await rows()).filter(line => line.includes("›"));
// The last entry is the draft that ctrl+c cleared above: codex keeps those in its history too.
check("persistence: prompt history survives the reload (arrow up recalls the last entry of history.jsonl)", recalled.some(line => /pasted via the paste event|long scroll|\/status/.test(line)), recalled);
await press("ArrowUp", 400); await press("ArrowUp", 400); await press("ArrowUp", 600);
const older = await text();
check("persistence: further arrow-ups walk back through earlier prompts", /long scroll|show me markdown|please use a tool/.test(older.slice(older.lastIndexOf("›"))), (await rows()).filter(line => line.includes("›")));
await press("Control+c", 500);

// ---- typing right at startup (the lost-input bug this port found in crossterm-wasi) ------------------
await page.goto(`${BASE}/?guest=codex`);
await waitFor("Ask Codex", 120000);
await page.evaluate(() => window.wasmTerm.program.write("hello there")); // one write: several key events from one read
await page.waitForTimeout(500);
const typedAhead = (await rows()).filter(line => line.includes("›"));
check("input burst: every character of a line typed in one go is shown without waiting for another key", typedAhead.some(line => line.includes("› hello there")), typedAhead);
await page.evaluate(() => window.wasmTerm.program.write("\r"));
const submitted = await turnDone("hello there", 30000).then(() => true, () => false);
check("input burst: Enter after it submits the prompt (it used to arrive glued to the stranded characters and read as a paste)", submitted, (await text()).split("\n").filter(Boolean).slice(-6));

// ---- approval prompt -------------------------------------------------------------------------------
await start("&sandbox=workspace-write");
await setTerminalSize(110, 40);
await prompt("run with approval");
await waitFor("Would you like to run the following command?", 30000);
await waitFor("Press enter to confirm or esc to cancel");
containsInOrder("approval prompt (sandbox=workspace-write, escalate scenario): equals the native capture (codex-tool-approval.txt)",
  await history(), baseline("codex-tool-approval").slice(baseline("codex-tool-approval").findIndex(line => line.includes("run with approval"))));
await shot("codex-approval");
await press("y", 500);
await waitFor("mock-llm-escalated-ok", 30000);
await turnDone("run with approval", 30000);
check("approval: after y the command runs on the server and the turn completes", /You approved/.test(await history()) && /mock-llm-escalated-ok/.test(await history()), (await text()).split("\n").filter(Boolean).slice(-12));
await shot("codex-approved");

// ---- exit ---------------------------------------------------------------------------------------------
await prompt("/quit");
await page.waitForFunction(() => window.wasmTerm.exit !== null, null, { timeout: 15000 }).catch(() => {});
const status = await exited();
const after = await page.evaluate(() => ({ buffer: window.wasmTerm.terminal.buffer.active.type, mouse: window.wasmTerm.terminal.hasMouseTracking() }));
check("exit: /quit ends the program with code 0, normal screen, mouse tracking off, resume hint printed",
  status?.code === 0 && after.buffer === "normal" && !after.mouse && /To reconnect, run:/.test(await history()), { status, after });
const afterExit = await page.evaluate(() => window.wasmTerm.readFile("/home/user/.codex/history.jsonl"));
check("debugging: files can still be read after the program has exited", /run with approval/.test(afterExit ?? ""), afterExit);
await shot("codex-exit");

// Leave no saved state behind: the next person to open the page gets the defaults.
await page.evaluate(() => new Promise((resolve) => {
  const request = indexedDB.open("wasm-term");
  request.onsuccess = () => {
    const transaction = request.result.transaction("files", "readwrite");
    transaction.objectStore("files").delete(IDBKeyRange.bound("codex\n", "codex\n￿"));
    transaction.oncomplete = resolve;
  };
}));
} catch (error) {
  check("the script ran to the end", false, String(error?.stack ?? error).slice(0, 600));
  await shot("codex-failure").catch(() => {});
}
await page.setViewportSize({ width: 1200, height: 800 });
const failed = checks.filter(item => !item.ok);
return { passed: checks.length - failed.length, failed: failed.length, startMs, load, failures: failed.map(item => `${item.name}: ${JSON.stringify(item.detail)}`), checks: checks.map(item => `${item.ok ? "PASS" : "FAIL"} ${item.name}`) };
