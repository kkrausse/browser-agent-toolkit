// Drives the real page in a real browser and checks each terminal function by
// reading the terminal's screen back. Run it through ./run.sh (dev server up),
// which supplies BASE and SHOTS; the browser-control relay has its own working
// directory, so the paths have to be absolute.
//
// Returns { passed, failed, failures, checks }. Screenshots go to docs/screenshots/.

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

const rows = async () => page.evaluate(() => window.wasmTerm.screen());
const text = async () => (await rows()).join("\n");
const lastLines = async (n) => (await rows()).filter((line, index, all) => all.slice(index).some(Boolean)).slice(-n);
const type = async (value) => { await page.keyboard.type(value, { delay: 5 }); await page.waitForTimeout(120); };
const press = async (key) => { await page.keyboard.press(key); await page.waitForTimeout(150); };
const enter = async (line) => { await type(line); await press("Enter"); };
const waitFor = (needle, timeout = 15000) =>
  page.waitForFunction((value) => window.wasmTerm?.screen().join("\n").includes(value), needle, { timeout });
const exited = () => page.evaluate(() => window.wasmTerm.exit);
const modes = () => page.evaluate(() => {
  const t = window.wasmTerm.terminal;
  return { buffer: t.buffer.active.type, paste: t.hasBracketedPaste(), focus: t.hasFocusEvents(), mouse: t.hasMouseTracking() };
});
const paste = (value) => page.evaluate((value) => {
  const data = new DataTransfer();
  data.setData("text/plain", value);
  document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}, value);
const open = async (guest, ready) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(`${BASE}/?guest=${guest}`);
  await waitFor(ready);
  await page.evaluate(() => window.wasmTerm.terminal.focus());
};
const cell = async (col, row) => {
  const [w, h] = await page.evaluate(() => { const m = window.wasmTerm.terminal.renderer.getMetrics(); return [m.width, m.height]; });
  return [col * w + w / 2, row * h + h / 2];
};
const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png` });

// ---- cooked mode: the line discipline --------------------------------------
await open("repl", "Type help.");
check("page is cross-origin isolated", await page.evaluate(() => crossOriginIsolated));
check("stdin is a tty; winsize matches the terminal", /stdin is a terminal, 120x47/.test(await text()), (await rows())[1]);

await type("echo hello");
check("ECHO: typed characters appear before Enter", (await lastLines(1))[0] === "wasm-term> echo hello");
await press("Enter");
check("canonical read delivers the line on Enter; ONLCR output", (await lastLines(2))[0] === "hello");

await type("echo abcX"); await press("Backspace");
check("ERASE (Backspace) rubs out one character", (await lastLines(1))[0] === "wasm-term> echo abc");
await type(" one two"); await press("Control+w");
check("WERASE (^W) rubs out one word", (await lastLines(1))[0] === "wasm-term> echo abc one");
await press("Control+u");
check("KILL (^U) rubs out the line", (await lastLines(1))[0] === "wasm-term>");
await type("echo "); await press("Control+v"); await press("Control+c");
check("LNEXT (^V ^C) inserts a literal ^C, no signal", (await lastLines(1))[0] === "wasm-term> echo ^C");
await press("Control+u");

await type("half a line"); await press("Control+c");
await waitFor("[SIGINT caught: line discarded]");
check("ISIG: ^C echoes ^C, raises SIGINT, interrupts the blocked read (EINTR), discards the line",
  (await lastLines(3))[0] === "wasm-term> half a line^C");
await type("abc"); await press("Control+d");
await waitFor("[partial line pushed by ^D]");
check("EOF (^D) mid-line pushes the partial line without a newline", true);
await press("Enter");

await enter("password"); await type("hunter2");
check("ECHO off: typed characters are not shown", (await lastLines(1))[0] === "password (not echoed):");
await press("Enter"); await waitFor("got 7 characters");
check("ECHO off + ECHONL: the line is still read, newline still echoed", true);

await enter("write notes.txt kept in the vfs"); await enter("cat /home/user/notes.txt");
check("vfs: write then read back a file in the home directory", (await lastLines(2))[0] === "kept in the vfs");
await enter("stty");
check("termios readable by the guest (stty)", (await text()).includes("icanon echo echoe echok echoctl isig iexten icrnl ixon opost onlcr"));

await page.setViewportSize({ width: 1000, height: 600 });
await waitFor("[SIGWINCH: now 100x35]");
check("resize: winsize updated and SIGWINCH delivered (cooked mode)", true);
await page.setViewportSize({ width: 1200, height: 800 });
await waitFor("[SIGWINCH: now 120x47]");
await shot("repl-cooked-mode");

// ---- raw mode byte protocols, seen exactly as the program reads them ---------
await enter("keys"); await waitFor("Press q to leave.");
const rawModes = await modes();
check("program enabled bracketed paste / focus / mouse (escape sequences reach the terminal)", rawModes.paste && rawModes.focus && rawModes.mouse, rawModes);
await paste("two\nlines");
await waitFor("\\e[200~two\\nlines\\e[201~");
check("bracketed paste passes through byte-exact", true);
await page.mouse.click(...(await cell(30, 12)));
await waitFor("\\e[<0;31;13M");
check("SGR mouse press/release pass through", (await text()).includes("\\e[<0;31;13m"));
await page.evaluate(() => window.wasmTerm.terminal.blur()); await page.waitForTimeout(200);
await page.evaluate(() => window.wasmTerm.terminal.focus());
await waitFor("\\e[I");
check("focus out / focus in reports pass through", (await text()).includes("\\e[O"));
await press("Control+a"); await press("Shift+Tab"); await press("ArrowUp"); await type("é");
await waitFor("\\xc3\\xa9");
const keyDump = await text();
check("kitty keyboard protocol: Ctrl+A arrives as CSI 97;5u", keyDump.includes("\\e[97;5u"));
check("raw mode: arrow key and UTF-8 bytes arrive untouched, nothing is echoed by the tty", keyDump.includes("\\e[A") && keyDump.includes("\\xc3\\xa9"));
await shot("repl-raw-key-dump");
await press("q"); await waitFor("wasm-term> ", 5000);
await page.waitForTimeout(300);
await enter("echo cooked again");
check("leaving raw mode restores cooked mode", (await lastLines(2))[0] === "cooked again");

await enter("trap off"); await enter("sleep 30"); await page.waitForTimeout(300); await press("Control+c");
await page.waitForFunction(() => window.wasmTerm.exit !== null);
check("default SIGINT disposition kills a program blocked in a timer", (await exited()).signal === 2, await exited());

await open("repl", "Type help.");
await press("Control+d");
await page.waitForFunction(() => window.wasmTerm.exit !== null);
check("EOF (^D) on an empty line: read returns 0, program exits 0", (await exited()).code === 0 && (await text()).includes("[EOF: read returned 0 bytes]"));

// ---- ratatui on CrosstermBackend, synchronous poll loop -----------------------
await open("tui", "ratatui on CrosstermBackend");
const tuiModes = await modes();
check("alternate screen entered; paste/focus/mouse modes on", tuiModes.buffer === "alternate" && tuiModes.paste && tuiModes.focus && tuiModes.mouse, tuiModes);
check("terminal answered crossterm's keyboard-enhancement query (terminal -> program replies)", (await text()).includes("kitty-keys"));
const tickOf = async () => Number(/tick (\d+)/.exec(await text())[1]);
const tick1 = await tickOf(); await page.waitForTimeout(1000); const tick2 = await tickOf();
check("timer-driven animation advances with no input (poll timeout)", tick2 - tick1 >= 8, `${tick2 - tick1} ticks in 1 s`);
await press("a"); await press("Control+a"); await press("F5"); await press("Alt+x");
await waitFor("Char('x') KeyModifiers(ALT)");
const keyLog = await text();
check("keyboard events with modifiers", keyLog.includes("Char('a') KeyModifiers(CONTROL)") && keyLog.includes("F(5)"));
await page.mouse.click(...(await cell(80, 20)));
await waitFor("Down(Left) at (80, 20)");
await page.mouse.move(...(await cell(70, 25))); await page.mouse.down(); await page.mouse.move(...(await cell(75, 25)), { steps: 5 }); await page.mouse.up();
await waitFor("Drag(Left) at (75, 25)");
await page.mouse.wheel(0, 120); await waitFor("ScrollDown");
check("mouse: press, release, drag, wheel with cell coordinates", (await text()).includes("Up(Left) at (75, 25)"));
check("mouse marks drawn where clicked", (await rows())[20][80] === "◆", (await rows())[20].slice(70, 90));
await page.mouse.click(...(await cell(8, 44))); await page.waitForTimeout(400);
const paused1 = await tickOf(); await page.waitForTimeout(700); const paused2 = await tickOf();
check("clicking the pause button stops the animation", paused1 === paused2 && (await text()).includes("▶ resume"), (await rows())[44]);
check("hovering reports motion without a button (no drag marks under the pointer)", !(await text()).includes("Drag(Left) at (8, 44)"));
await shot("tui-ratatui-mouse-and-keys");
await page.mouse.click(...(await cell(8, 44)));
await paste("pasted into the tui");
await waitFor('paste  19 chars: "pasted into the tui"');
check("Event::Paste", true);
await page.evaluate(() => window.wasmTerm.terminal.blur()); await waitFor("unfocused");
await page.evaluate(() => window.wasmTerm.terminal.focus()); await waitFor("focus  gained");
check("Event::FocusLost / FocusGained", true);
await page.setViewportSize({ width: 900, height: 560 });
await waitFor("resize 90x32");
check("Event::Resize and relayout at the new size", (await text()).includes("90x32  resizes 1"));
await shot("tui-ratatui-resized");
await page.setViewportSize({ width: 1200, height: 800 });
await waitFor("resize 120x47");
await shot("tui-ratatui");
await press("q");
await page.waitForFunction(() => window.wasmTerm.exit !== null);
const afterTui = await modes();
check("quit: alternate screen left, modes reset, cooked mode restored, exit 0",
  afterTui.buffer === "normal" && !afterTui.paste && !afterTui.focus && (await exited()).code === 0 && (await text()).includes("left the alternate screen"), afterTui);
check("cursor position query (CSI 6n) answered", (await text()).includes("cursor position query: Ok("));

// ---- network ----------------------------------------------------------------
await open("net", "5. Interactive");
const netText = await text();
check("HTTP POST: status, headers, body", netText.includes("PASS status 200, response header, request header and body round-trip"));
check("streaming HTTP body arrives incrementally", netText.includes("PASS body arrived incrementally"));
check("WebSocket: open, text, binary, close", netText.includes("PASS open, greeting, text echo, binary echo") && netText.includes("PASS server-initiated close with code and reason"));
check("network failures are reported", netText.includes("PASS a network error is an Err") && netText.includes("PASS a failed WebSocket reports Error"));
check("no FAIL lines", !netText.includes("FAIL"));
await waitFor('[ws] TEXT "hello from /test/ws"');
await enter("tick"); await enter("sse"); await enter("typed during the stream");
await waitFor('[ws] TEXT "echo: typed during the stream"');
await waitFor("[sse] end of stream"); await waitFor("[timer] tick 3");
check("one poll loop multiplexes keyboard + WebSocket + event stream + timer", true);
await shot("net-guest");
await enter("tick"); await enter("quit");
await page.waitForFunction(() => window.wasmTerm.exit !== null);

// ---- the codex shape: tokio + crossterm EventStream + ratatui + WebSocket -----
await open("async-tui", 'Text("hello from /test/ws")');
await enter("hello from tokio");
await waitFor('Text("echo: hello from tokio")');
check("tokio: EventStream keys -> WebSocket send -> async recv", true);
await press("F2");
await waitFor("end of stream");
check("tokio: spawned task streams an HTTP body while the UI stays live", (await text()).includes('{\\"n\\":3,\\"of\\":5}'));
const asyncTick1 = Number(/tick (\d+)/.exec(await text())[1]); await page.waitForTimeout(1000);
const asyncTick2 = Number(/tick (\d+)/.exec(await text())[1]);
check("tokio: time::interval ticks while idle", asyncTick2 - asyncTick1 >= 5, `${asyncTick2 - asyncTick1} ticks in 1 s`);
await page.mouse.click(...(await cell(40, 17))); await waitFor("Down(Left) at (40, 17)");
await page.setViewportSize({ width: 1000, height: 600 });
await waitFor("100x35");
check("tokio: mouse and resize through EventStream", (await text()).includes("resize"));
await shot("async-tui-tokio-eventstream");
await press("Escape");
await page.waitForFunction(() => window.wasmTerm.exit !== null);
check("tokio: clean exit", (await exited()).code === 0);

await page.setViewportSize({ width: 1200, height: 800 });
const failed = checks.filter(item => !item.ok);
return { passed: checks.length - failed.length, failed: failed.length, failures: failed, checks: checks.map(item => `${item.ok ? "PASS" : "FAIL"} ${item.name}`) };
