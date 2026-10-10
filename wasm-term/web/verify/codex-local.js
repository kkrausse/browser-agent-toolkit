// Drives the codex-local guest (the codex TUI with its app-server and agent
// core in the same wasm module) on the dev page in a real browser. Model and
// sign-in requests go through the page server's relay (/proxy/http) to
// mock-llm (mock-llm/up.sh): no real model, no real account. Run through
// ./run.sh codex-local, which supplies BASE, SHOTS and ROOT.
//
// Nothing reaches a real host unless CODEX_LOCAL_REAL_AUTH=1 is set for run.sh:
// then one more section asks the real auth.openai.com for a device code (the
// unauthenticated first step of the sign-in flow; nothing is approved).
// run.sh also supplies REAL_AUTH and IMPORT_ZIP (a small deflated archive).
//
// Returns { passed, failed, failures, checks }. Screenshots go to docs/screenshots/.

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: ok ? undefined : detail });

const rows = async () => page.evaluate(() => window.wasmTerm.screen());
const text = async () => (await rows()).join("\n");
const type = async (value) => { await page.keyboard.type(value, { delay: 12 }); await page.waitForTimeout(250); };
const press = async (key, pause = 300) => { await page.keyboard.press(key); await page.waitForTimeout(pause); };
const waitFor = (needle, timeout = 20000) =>
  page.waitForFunction((value) => window.wasmTerm?.screen().join("\n").includes(value), needle, { timeout });
const exited = () => page.evaluate(() => window.wasmTerm.exit);
const focus = () => page.evaluate(() => window.wasmTerm.terminal.focus());
// In front first: a tab behind another one in the shared browser produces no frames, and a screenshot of a static page then never completes.
const shot = async (name) => { await page.bringToFront(); return page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const readFile = (path) => page.evaluate((path) => window.wasmTerm.readFile(path), path);
const listFiles = (dir) => page.evaluate((dir) => window.wasmTerm.listFiles(dir), dir);
const prompt = async (value) => { await type(value); await press("Enter"); };
const turnDone = (value, timeout = 30000) => page.waitForFunction((value) => {
  const screen = window.wasmTerm.screen().join("\n");
  if (/esc to interrupt/.test(screen) || !screen.includes("Ask Codex to do anything")) return false;
  const echo = screen.lastIndexOf(`› ${value.slice(0, 40)}`);
  return /Worked for /.test(echo < 0 ? screen : screen.slice(echo));
}, value, { timeout });
const turn = async (value, timeout = 30000) => {
  await prompt(value);
  await page.waitForTimeout(500);
  await turnDone(value, timeout);
  await page.waitForTimeout(400);
};
const open = async (query = "") => {
  await page.goto(`${BASE}/?guest=codex-local${query}`);
  await page.waitForFunction(() => window.wasmTerm?.screen().join("").trim() || window.wasmTerm?.exit, null, { timeout: 180000 });
};
const start = async (query = "") => {
  await open(query);
  await waitFor("Ask Codex", 120000);
  await waitFor("~/project", 30000);
  await focus();
  await page.waitForTimeout(600);
};
/** mock-llm's record of the sign-in endpoints and of the credentials model requests carried, read through the relay. */
const mock = (path = "/auth/state", method = "GET") =>
  page.evaluate(async ([path, method]) => {
    const response = await fetch(`/proxy/http/127.0.0.1:4791${path}`, { method });
    const body = await response.text();
    try { return JSON.parse(body); } catch { return body; }
  }, [path, method]);
/** What IndexedDB holds for the guest: path -> size. */
const stored = () => page.evaluate(() => new Promise((resolve, reject) => {
  const request = indexedDB.open("wasm-term", 1);
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const out = {};
    const cursor = request.result.transaction("files").objectStore("files").openCursor();
    cursor.onsuccess = () => {
      const at = cursor.result;
      if (!at) return resolve(out);
      const key = String(at.key);
      if (key.startsWith("codex-local\n")) out[key.slice("codex-local\n".length)] = at.value.byteLength;
      at.continue();
    };
  };
}));
const SEEDED = "hello from the wasm-term sample project";
const PROJECT = "/home/user/project";
/** The child processes that have ended (host/index.ts `Program.procs`). */
const procs = () => page.evaluate(() => window.wasmTerm.program.procs);
const lastProc = async () => (await procs()).at(-1) ?? {};
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (value) => Math.round(value * 100) / 100;
  return sorted.length ? { n: sorted.length, min: round(sorted[0]), median: round(sorted[Math.floor((sorted.length - 1) / 2)]), max: round(sorted.at(-1)) } : { n: 0 };
};
/** Everything on screen after the last echo of `value`, joined so that a wrapped line still matches. */
const since = async (value) => {
  const screen = await text();
  const at = screen.lastIndexOf(`› ${value.slice(0, 40)}`);
  return at < 0 ? screen : screen.slice(at);
};
const numbers = {};

let load = null;
try {
// ---- the launcher ------------------------------------------------------------
await page.setViewportSize({ width: 1200, height: 800 });
await page.goto(`${BASE}/`);
await page.waitForSelector('form input[name="guest"][value="codex-local"]', { state: "attached" });
const defaults = await page.evaluate(() => {
  const form = document.querySelector('input[name="guest"][value="codex-local"]').form;
  return { ...Object.fromEntries([...new FormData(form)]), buttons: [...form.querySelectorAll("button")].map(button => button.textContent) };
});
check("launcher lists codex-local: mock backend, the relay, a project directory in the tab, a credentials button, the import buttons",
  defaults.backend === "mock" && defaults.relay === "/proxy/http" && defaults.dir === "/home/user/project" && defaults.buttons.includes("Clear stored credentials")
    && defaults.buttons.includes("Import folder") && defaults.buttons.includes("Import .zip"), defaults);

// ---- the relay by itself --------------------------------------------------------
const relay = await page.evaluate(async () => {
  const refused = await fetch("/proxy/http/example.com/");
  const echo = await fetch("/proxy/http/127.0.0.1:4791/health", { headers: { "x-wasm-term-fwd-user-agent": "relay-check/1" } });
  return { refused: refused.status, ok: echo.status };
});
check("relay: refuses a host that is not allowlisted (403), reaches the mock (200)", relay.refused === 403 && relay.ok === 200, relay);
await mock("/auth/reset", "POST");

// ---- start, plain turn ----------------------------------------------------------
const started = Date.now();
await start("&reset=1");
const startMs = Date.now() - started;
load = await page.evaluate(() => window.wasmTerm.load);
const home = await text();
check("start screen: banner, project directory, mock model, no sign-in screen", /OpenAI Codex \(v0\.162\.0\)/.test(home) && /mock-model/.test(home) && !/Sign in with ChatGPT/.test(home), home);
await turn("hello there");
check("plain prompt: the scripted reply streamed in", /Hello from mock-llm\. This is a scripted plain-text reply/.test(await text()), await text());
await shot("codex-local-plain");
let state = await mock();
const first = state.modelRequests.at(-1) ?? {};
check("the model request left the tab through the relay with codex's own headers (User-Agent, originator), no credentials",
  /^codex/.test(first.userAgent) && /^codex/.test(first.originator) && first.authorization === "(none)", first);

// ---- markdown, long reply -------------------------------------------------------
await turn("show me markdown");
const markdown = await text();
check("markdown reply rendered (heading, list, code, table)", /Scripted markdown/.test(markdown) && /━━━/.test(markdown) && /export function add/.test(markdown), markdown);
await shot("codex-local-markdown");
await turn("long scroll", 60000);
check("long reply streamed to its end", /END-OF-LONG-RESPONSE/.test(await text()), await text());

// ---- file tool: apply_patch against the tab's filesystem -------------------------
const before = await readFile("/home/user/project/hello.txt");
const seeded = (await listFiles(PROJECT)).map(file => file.path.slice(PROJECT.length + 1)).sort();
check("the sample project was seeded: a README, sources in src/, tests, data, notes",
  before === `${SEEDED}\n` && seeded.join(" ") === ".gitignore README.md data/items.csv hello.txt notes/todo.md src/inventory.py src/main.py src/report.py tests/test_inventory.py", { before, seeded });
await turn(`change hello.txt "${SEEDED}"`);
const edited = await text();
const after = await readFile("/home/user/project/hello.txt");
check("apply_patch turn: the TUI shows the edit and the turn completes", /Edited hello\.txt \(\+1 -1\)/.test(edited) && /MOCK-TOOL-DONE/.test(edited), edited);
check("apply_patch really changed the file in the vfs", after === `${SEEDED} (changed by mock-llm)\n`, after);
await shot("codex-local-apply-patch");
await turn("please write a file");
check("apply_patch can add a file", (await readFile("/home/user/project/mock-output.txt")) === "written by mock-llm\nsecond line\n", await readFile("/home/user/project/mock-output.txt"));

// ---- the shell: exec_command runs for real ---------------------------------------------
check("the page started a shell Worker before the first command", (await page.evaluate(() => window.wasmTerm.program.shellWorkers)).length >= 1, await page.evaluate(() => window.wasmTerm.program.shellWorkers));
await turn("please use a tool");
const shell = await since("please use a tool");
let proc = await lastProc();
check("exec_command: the command ran in the tab's shell, its output and exit status reached the model",
  /Ran echo mock-llm-tool-ok/.test(shell) && /First line: `mock-llm-tool-ok`/.test(shell) && /\/home\/user\/project/.test(shell) && /MOCK-TOOL-DONE/.test(shell)
    && /^\/bin\/bash -lc echo mock-llm-tool-ok && pwd$/.test(proc.command) && proc.status === 0, { shell, proc });
await shot("codex-local-shell-tool");

// Reading a project the way a model does: rg --files, rg -n, nl -ba | sed -n, sed -n, cat, ls -la.
let mark = (await procs()).length;
await turn("shell-read", 90000);
const read = (await since("shell-read")).replace(/\n\s*/g, " ");
const readProcs = (await procs()).slice(mark);
check("read turn: six commands (rg --files, rg -n, nl -ba | sed -n, sed -n, cat, ls -la) all exit 0 with the right first lines",
  /1\. exit 0: `README\.md`/.test(read) && /2\. exit 0: `src\/inventory\.py:\d+:def load_items\(path: str\)/.test(read) && /3\. exit 0: `\s*1\s+"""Formatting the inventory report\."""`/.test(read)
    && /4\. exit 0: `# Sample project: pantry`/.test(read) && /5\. exit 0: `name,quantity,unit_price`/.test(read) && /6\. exit 0: `total \d+`/.test(read) && /MOCK-SHELL-READ-DONE/.test(read)
    && readProcs.length === 6 && readProcs.every(entry => entry.status === 0), { read, readProcs });
await shot("codex-local-shell-read");

// Read, edit with apply_patch, verify with the shell.
await turn("shell-fix", 90000);
const fix = (await since("shell-fix")).replace(/\n\s*/g, " ");
const report = await readFile(`${PROJECT}/src/report.py`);
check("read-edit-verify turn: rg finds the TODO, apply_patch edits the file, the shell sees the edit",
  /1\. exit 0: `src\/inventory\.py:\d+:\s+# TODO/.test(fix) && /Verification: `edit-verified`/.test(fix) && /MOCK-SHELL-FIX-DONE/.test(fix)
    && /sorted\(items, key=lambda item: item\.name\)/.test(report ?? "") && !/TODO: sort/.test(report ?? ""), { fix, report });
await shot("codex-local-shell-fix");

// Failing commands and programs this machine does not have: an answer at once, never a hang.
mark = (await procs()).length;
await turn("shell-fail", 90000);
const fail = (await since("shell-fail")).replace(/\n\s*/g, " ");
const failProcs = (await procs()).slice(mark);
check("failing commands: a missing file is exit 1 with cat's message; git and python fail at once with a message; the status of a list is its last command's",
  /1\. exit 1: `cat: does-not-exist\.txt: No such file or directory`/.test(fail) && /2\. exit (12[0-9]|1): `[^`]*git[^`]*`/.test(fail) && /3\. exit 127: `[^`]*python3[^`]*`/.test(fail)
    && /4\. exit 1: `rg=1`/.test(fail) && /MOCK-SHELL-FAIL-DONE/.test(fail) && failProcs.length === 4 && failProcs.every(entry => entry.runMs < 250), { fail, failProcs });
await shot("codex-local-shell-fail");

// Long output: all of it is produced, codex truncates what the model sees.
await turn("shell-long", 90000);
const long = (await since("shell-long")).replace(/\n\s*/g, " ");
proc = await lastProc();
check("long output: 60,000 lines are produced and the model gets a bounded view ending in the last line",
  /Output seen by the model: \d+ chars, \d+ lines, last line `60000`/.test(long) && /MOCK-SHELL-LONG-DONE/.test(long) && /seq 1 60000$/.test(proc.command) && proc.status === 0, { long, proc });

// A command that takes too long, under the shell's own `timeout`.
const timeoutStarted = Date.now();
await turn("shell-timeout", 90000);
const timedOut = (await since("shell-timeout")).replace(/\n\s*/g, " ");
check("timeout: `timeout 1 sleep 30` ends after a second with status 124", /Last line: `timeout-status=124`/.test(timedOut) && Date.now() - timeoutStarted < 15000, { timedOut, ms: Date.now() - timeoutStarted });

// A process left running past the yield time, interrupted by the model (write_stdin "\x03"), and the shell after it.
await turn("shell-ctrlc", 90000);
const ctrlc = (await since("shell-ctrlc")).replace(/\n\s*/g, " ");
const interrupted = (await procs()).find(entry => /sleep 300/.test(entry.command)) ?? {};
check("model interrupt: the command is still running after the yield time, Ctrl-C through write_stdin ends it (SIGINT, 130), the next command runs",
  /Session \d+ was running after the first call/.test(ctrlc) && /3\. exit 0: `after-interrupt`/.test(ctrlc) && /MOCK-SHELL-CTRLC-DONE/.test(ctrlc) && interrupted.signal === 2 && interrupted.status === 130, { ctrlc, interrupted });

// An interactive process on the terminal stand-in: lines typed with write_stdin, answers read back.
await turn("shell-stdin", 90000);
const stdin = (await since("shell-stdin")).replace(/\n\s*/g, " ");
const loop = (await procs()).find(entry => /while IFS= read -r line/.test(entry.command)) ?? {};
check("write_stdin: lines typed into a running `while read` loop are answered, and the loop ends on the last one",
  /got:hello from stdin/.test(stdin) && /got:quit/.test(stdin) && /bye/.test(stdin) && /MOCK-SHELL-STDIN-DONE/.test(stdin) && loop.status === 0, { stdin, loop });
await shot("codex-local-shell-stdin");

// The user interrupts a turn whose command is still running (Esc). As natively, codex keeps the process as a
// "background terminal"; /stop closes it, which kills the command.
await prompt("shell-sleep");
await page.waitForFunction(() => /background terminal running/.test(window.wasmTerm.screen().join("\n")) && /esc to interrupt/.test(window.wasmTerm.screen().join("\n")), null, { timeout: 30000 }).catch(() => {});
const running = await since("shell-sleep");
await shot("codex-local-shell-running");
await press("Escape", 300);
await page.waitForFunction(() => !/esc to interrupt/.test(window.wasmTerm.screen().join("\n")), null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(500);
const afterEsc = await since("shell-sleep");
const stillRunning = !(await procs()).some(entry => /sleep 120/.test(entry.command));
check("Esc while a command runs: the TUI stays live during the command, the turn is interrupted, the command lives on as a background terminal",
  /esc to interrupt/.test(running) && /1 background terminal running/.test(running) && /Conversation interrupted/.test(afterEsc) && /1 background terminal running/.test(afterEsc) && stillRunning, { running, afterEsc, stillRunning });
const stopAt = Date.now();
await prompt("/stop");
await page.waitForFunction(() => window.wasmTerm.program.procs.some(entry => /sleep 120/.test(entry.command)), null, { timeout: 15000 }).catch(() => {});
numbers.stopToKilledMs = Date.now() - stopAt;
await page.waitForTimeout(800);
const slept = (await procs()).find(entry => /sleep 120/.test(entry.command)) ?? {};
check("/stop closes the background terminal: the command is killed (SIGKILL) long before it would have ended",
  slept.signal === 9 && slept.status === 137 && slept.runMs < 60000 && !/background terminal running/.test((await rows()).slice(-6).join("\n")), { slept, tail: (await rows()).slice(-8) });
await shot("codex-local-shell-interrupted");

// The user's own commands from the composer: `!command`.
await prompt("!rg -n greet src");
await waitFor("src/main.py:7:def greet", 20000).catch(() => {});
await page.waitForTimeout(800);
const bang = await text();
check("!command: the user's `!rg -n greet src` runs in the same shell and shows its output", /src\/main\.py:7:def greet\(name: str\) -> str:/.test(bang) && /src\/main\.py:\d+:\s+print\(greet\("pantry"\)\)/.test(bang), bang);
await prompt("!echo written-by-the-shell > from-shell.txt; ls nope-missing");
await page.waitForFunction(() => window.wasmTerm.program.procs.some(entry => /from-shell\.txt/.test(entry.command)), null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1000);
const bangFail = await text();
check("!command: a failing command shows its error; the file it wrote is in the filesystem codex's tools use",
  /nope-missing/.test(bangFail) && /No such file or directory/.test(bangFail) && (await readFile(`${PROJECT}/from-shell.txt`)) === "written-by-the-shell\n", { bangFail, file: await readFile(`${PROJECT}/from-shell.txt`) });
await shot("codex-local-bang-command");

// What it costs, as codex sees it: every command so far, and the searches in particular.
{
  const all = await procs();
  const rg = all.filter(entry => /-lc rg /.test(entry.command) && entry.status === 0);
  numbers.commands = all.length;
  numbers.spawnToShellRunningMs = stats(all.map(entry => entry.queueMs));
  numbers.echoRunMs = stats(all.filter(entry => /-lc echo /.test(entry.command)).map(entry => entry.runMs));
  numbers.rgOverSampleProjectRunMs = stats(rg.map(entry => entry.runMs));
  numbers.rgHostCalls = stats(rg.map(entry => entry.calls));
  numbers.rg = rg.map(entry => ({ command: entry.command.replace("/bin/bash -lc ", ""), ms: Math.round((entry.queueMs + entry.runMs) * 100) / 100, calls: entry.calls }));
  numbers.shellWorkers = await page.evaluate(() => window.wasmTerm.program.shellWorkers.map(worker => `${worker.why} slot ${worker.slot}`));
}

// ---- persistence, reload, history, resume ------------------------------------------
await page.waitForTimeout(1500);
const saved = await stored();
const rollouts = Object.keys(saved).filter(path => /\/\.codex\/sessions\/.*\.jsonl$/.test(path));
check("IndexedDB holds the project (the shell-written file and the patched one too), config, history and the session rollout; no credentials, no SQLite",
  saved["/home/user/project/hello.txt"] > 0 && saved["/home/user/project/from-shell.txt"] === 21 && saved["/home/user/project/src/report.py"] > 0
    && saved["/home/user/.codex/history.jsonl"] > 0 && rollouts.length >= 1
    && !("/home/user/.codex/auth.json" in saved) && !Object.keys(saved).some(path => path.includes(".sqlite")), Object.keys(saved).filter(path => !path.includes("/skills/")));
await start();
check("after a reload the edited file and the shell-written file are still there",
  (await readFile("/home/user/project/hello.txt")) === `${SEEDED} (changed by mock-llm)\n` && (await readFile(`${PROJECT}/from-shell.txt`)) === "written-by-the-shell\n");
await press("ArrowUp", 600);
check("after a reload arrow-up recalls the last prompt", /› !echo written-by-the-shell/.test(await text()), await text());
await press("Control+c", 500);
await prompt("/resume");
await page.waitForTimeout(2500);
const picker = await text();
check("/resume lists the session from before the reload", /hello there/.test(picker), picker);
await shot("codex-local-resume-picker");
await press("Enter", 3000);
await waitFor("Ask Codex", 20000).catch(() => {});
const resumed = await text();
check("resuming it replays the earlier transcript", /MOCK-|Hello from mock-llm|from-shell/.test(resumed), resumed);
await turn("hello again after resume");
check("the resumed session takes another turn", /Hello from mock-llm/.test((await text()).split("hello again after resume").pop() ?? ""), await text());
await shot("codex-local-resumed");
await prompt("/quit");
await page.waitForFunction(() => window.wasmTerm.exit, null, { timeout: 15000 }).catch(() => {});
check("/quit ends the program with code 0", (await exited())?.code === 0, await exited());

// ---- without a shell: the readable error --------------------------------------------------
await start("&shell=off&env=CODEX_WASM_SHELL=0");
await turn("please use a tool");
const noShell = await since("please use a tool");
check("without a shell (&shell=off): a readable 'no shell in this build' tool error, and the turn completes",
  /no shell in this build/.test(noShell) && /MOCK-TOOL-DONE/.test(noShell) && /exec_command failed/.test(noShell), noShell);

// ---- inline mode: the shell inside the guest's own Worker ------------------------------------
await start("&shell=inline");
await turn("shell-read", 90000);
const inline = (await since("shell-read")).replace(/\n\s*/g, " ");
check("inline shell (&shell=inline): the read turn gives the same answers with no shell Worker",
  /1\. exit 0: `README\.md`/.test(inline) && /6\. exit 0: `total \d+`/.test(inline) && /MOCK-SHELL-READ-DONE/.test(inline)
    && (await page.evaluate(() => window.wasmTerm.program.shellWorkers)).length === 0, { inline, workers: await page.evaluate(() => window.wasmTerm.program.shellWorkers) });
numbers.inlineRgRunMs = stats((await procs()).filter(entry => /-lc rg /.test(entry.command)).map(entry => entry.runMs));

// ---- importing the user's own files, and forgetting everything --------------------------------
await page.goto(`${BASE}/`);
await page.waitForSelector('form input[name="guest"][value="codex-local"]', { state: "attached" });
const form = page.locator('form:has(input[name="guest"][value="codex-local"])');
await form.locator("input.import-zip").setInputFiles(IMPORT_ZIP);
await page.waitForFunction(() => /Imported|failed/.test(document.querySelector('form:has(input[name="guest"][value="codex-local"]) output')?.textContent ?? ""), null, { timeout: 15000 }).catch(() => {});
const zipStatus = await form.locator("output").textContent();
await shot("codex-local-import");
await start();
const imported = (await listFiles(PROJECT)).map(file => file.path.slice(PROJECT.length + 1));
check("launcher: 'Import .zip' puts an archive's files (deflated, one top folder stripped, .git left out) into the project beside what was there",
  /Imported 3 files/.test(zipStatus ?? "") && (await readFile(`${PROJECT}/imported/notes.txt`)) === "imported by the verify script\n" && (await readFile(`${PROJECT}/top.md`))?.startsWith("# imported")
    && (await readFile(`${PROJECT}/imported/big.txt`))?.length === 60000 && imported.includes("hello.txt") && !imported.some(path => path.includes(".git/")), { zipStatus, imported });
await turn("!rg -c imported top.md imported/notes.txt", 30000).catch(() => {});
await page.waitForTimeout(800);
check("the imported files are there for the shell", /top\.md:1/.test(await text()) && /imported\/notes\.txt:1/.test(await text()), await text());
await page.goto(`${BASE}/`);
await page.waitForSelector('form input[name="guest"][value="codex-local"]', { state: "attached" });
await form.locator("input.import-replace").check();
await form.locator("input.import-folder").setInputFiles(`${ROOT}/ports/codex/main/sample/src`);
await page.waitForFunction(() => /Imported|failed/.test(document.querySelector('form:has(input[name="guest"][value="codex-local"]) output')?.textContent ?? ""), null, { timeout: 15000 }).catch(() => {});
const folderStatus = await form.locator("output").textContent();
await start();
const replaced = (await listFiles(PROJECT)).map(file => file.path.slice(PROJECT.length + 1)).sort();
check("launcher: 'Import folder' with 'replace what is there' leaves exactly the folder's files in the project",
  /Imported 3 files/.test(folderStatus ?? "") && replaced.join(" ") === "inventory.py main.py report.py", { folderStatus, replaced });
await page.goto(`${BASE}/`);
await page.waitForSelector('form input[name="guest"][value="codex-local"]', { state: "attached" });
await form.getByRole("button", { name: "Forget saved state" }).click();
await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Forgotten"), null, { timeout: 10000 }).catch(() => {});
await start();
const fresh = (await listFiles(PROJECT)).map(file => file.path.slice(PROJECT.length + 1)).sort();
check("'Forget saved state' brings the sample project back", fresh.length === 9 && fresh.includes("src/report.py") && /TODO: sort/.test((await readFile(`${PROJECT}/src/report.py`)) ?? ""), fresh);

// ---- sign in: device code, against mock-llm's fake auth server --------------------------
await mock("/auth/reset", "POST");
await open("&backend=mock-auth&reset=1");
await waitFor("Sign in with ChatGPT", 120000);
await focus();
const onboarding = await text();
check("signed out, codex's own provider: the sign-in screen (ChatGPT, device code, API key)",
  /Sign in with ChatGPT/.test(onboarding) && /Sign in with Device Code/.test(onboarding) && /Provide your own API key/.test(onboarding), onboarding);
await shot("codex-local-signin-options");
await press("Enter", 500);
await waitFor("MOCK-", 20000);
const device = await text();
const code = /MOCK-\d+/.exec(device)?.[0];
check("'Sign in with ChatGPT' shows the device-code URL and a one-time code in the TUI",
  /https:\/\/mock-llm\.test\/auth\/codex\/device/.test(device) && !!code, device);
await shot("codex-local-device-code");
await page.waitForTimeout(2500);
state = await mock();
check("the TUI polls the token endpoint through the relay while it waits", state.logins[0]?.polls >= 1 && !state.logins[0]?.approved, state.logins);
await mock(`/auth/codex/device?user_code=${code}`); // the user approving in another tab
await waitFor("Press enter to continue", 30000).catch(() => {});
const signedIn = await text();
check("after approval the TUI reports being signed in", /Signed in with your ChatGPT account|You're in control|Press enter to continue/.test(signedIn), signedIn);
await shot("codex-local-signed-in");
for (let i = 0; i < 3 && !/Ask Codex/.test(await text()); i++) await press("Enter", 1500);
await waitFor("Ask Codex", 30000);
const auth = JSON.parse((await readFile("/home/user/.codex/auth.json")) ?? "{}");
check("tokens are stored in CODEX_HOME/auth.json in the vfs", auth.auth_mode === "chatgpt" && /^mock-refresh-/.test(auth.tokens?.refresh_token) && auth.tokens?.account_id === "acct_mock_0001", { ...auth, tokens: Object.keys(auth.tokens ?? {}) });
await turn("hello there");
state = await mock();
const authed = state.modelRequests.at(-1) ?? {};
check("the authenticated model request carries the bearer token and account id to the mock",
  /^Bearer mock access-\d+$/.test(authed.authorization) && authed.account === "acct_mock_0001" && /Hello from mock-llm/.test(await text()), authed);
check("token refresh went through the relay (the first access token was inside the refresh window)",
  state.refreshes >= 1 && authed.authorization === `Bearer mock access-${state.generation}` && state.generation >= 2, { refreshes: state.refreshes, generation: state.generation, authed });
check("the post-login account check was answered", state.accountChecks.some(entry => entry.status === 200), state.accountChecks);
await page.waitForTimeout(1500);
check("auth.json is persisted (IndexedDB)", (await stored())["/home/user/.codex/auth.json"] > 0, Object.keys(await stored()).filter(path => !path.includes("/skills/")));
await start("&backend=mock-auth");
check("after a reload: still signed in, no sign-in screen", !/Sign in with ChatGPT/.test(await text()), await text());

// ---- sign out: /logout ---------------------------------------------------------------
await prompt("/logout");
await page.waitForFunction(() => window.wasmTerm.exit, null, { timeout: 20000 }).catch(() => {});
state = await mock();
check("/logout: the program exits, the token is revoked at the auth server, auth.json is gone",
  !!(await exited()) && state.revoked.length === 1 && (await readFile("/home/user/.codex/auth.json")) === null, { exit: await exited(), revoked: state.revoked.length });
await page.waitForTimeout(1000);
check("/logout: auth.json is gone from IndexedDB too", !("/home/user/.codex/auth.json" in (await stored())));
await open("&backend=mock-auth");
await waitFor("Sign in with ChatGPT", 60000);
check("after /logout a reload shows the sign-in screen again", true);

// ---- API key, and the page-level sign-out ------------------------------------------------
await focus();
await press("3", 800);
await page.waitForTimeout(500);
const keyScreen = await text();
await type("sk-mock-not-a-real-key");
await press("Enter", 2000);
for (let i = 0; i < 3 && !/Ask Codex/.test(await text()); i++) await press("Enter", 1500);
await waitFor("Ask Codex", 30000).catch(() => {});
const keyAuth = JSON.parse((await readFile("/home/user/.codex/auth.json")) ?? "{}");
check("API key path: the key is stored in auth.json", keyAuth.OPENAI_API_KEY === "sk-mock-not-a-real-key", { keyScreen, keys: Object.keys(keyAuth), screen: await text() });
await turn("hello there");
state = await mock();
check("API key path: the model request carries it as a bearer token", (state.modelRequests.at(-1)?.authorization ?? "").startsWith("Bearer sk-mock-not-a-rea"), state.modelRequests.at(-1));
await page.waitForTimeout(1200);
await open("&backend=mock-auth&signout=1");
await waitFor("Sign in with ChatGPT", 60000).catch(() => {});
check("page-level sign-out (&signout=1): credentials gone, everything else kept",
  /Sign in with ChatGPT/.test(await text()) && !("/home/user/.codex/auth.json" in (await stored())) && (await stored())["/home/user/.codex/history.jsonl"] > 0, await text());

// ---- the real auth host: only the unauthenticated request for a code -------------------------
if (REAL_AUTH) {
  await open("&backend=openai&signout=1");
  await waitFor("Sign in with ChatGPT", 60000);
  await focus();
  await press("Enter", 500);
  const outcome = await page.waitForFunction(() => {
    const screen = window.wasmTerm.screen().join("\n");
    if (/auth\.openai\.com\/codex\/device/.test(screen)) return "code";
    if (/Press enter to continue/.test(screen) && /Sign in with ChatGPT/.test(screen) && /fail|error|not enabled|denied/i.test(screen)) return "error";
    return false;
  }, null, { timeout: 30000 }).then(handle => handle.jsonValue()).catch(() => "timeout");
  const real = (await text()).replace(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,6}\b/g, "<code>");
  check("real auth.openai.com through the relay: the device-code URL and a code appear in the TUI (nothing is approved)", outcome === "code", real);
  await shot("codex-local-real-device-code");
  await press("Escape", 800);
  check("Esc cancels the pending sign-in", /Sign in with Device Code/.test(await text()), await text());
  check("no credentials were stored by the cancelled real sign-in", (await readFile("/home/user/.codex/auth.json")) === null);
}
} catch (error) {
  check("script ran to the end", false, { error: String(error?.stack ?? error), screen: await text().catch(() => null) });
}

const failures = checks.filter(entry => !entry.ok);
return { passed: checks.length - failures.length, failed: failures.length, load, numbers, failures, checks: checks.map(entry => `${entry.ok ? "ok  " : "FAIL"} ${entry.name}`) };
