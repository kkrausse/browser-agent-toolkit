// Drives the codex-local guest (the codex TUI with its app-server and agent
// core in the same wasm module) on the dev page in a real browser. Model and
// sign-in requests go through the page server's relay (/proxy/http) to
// mock-llm (mock-llm/up.sh): no real model, no real account. Run through
// ./run.sh codex-local, which supplies BASE, SHOTS and ROOT.
//
// One request does reach a real host: the unauthenticated first step of the
// device-code flow against auth.openai.com (it only asks for a code). Skip it
// with CODEX_LOCAL_SKIP_REAL=1 in the environment of the browser-control relay,
// or by setting SKIP_REAL below.
//
// Returns { passed, failed, failures, checks }. Screenshots go to docs/screenshots/.

const SKIP_REAL = false;
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
check("launcher lists codex-local: mock backend, the relay, a project directory in the tab, a credentials button",
  defaults.backend === "mock" && defaults.relay === "/proxy/http" && defaults.dir === "/home/user/project" && defaults.buttons.includes("Clear stored credentials"), defaults);

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
check("the sample project was seeded", before === `${SEEDED}\n` && (await listFiles("/home/user/project")).length === 4, { before, files: await listFiles("/home/user/project") });
await turn(`change hello.txt "${SEEDED}"`);
const edited = await text();
const after = await readFile("/home/user/project/hello.txt");
check("apply_patch turn: the TUI shows the edit and the turn completes", /Edited hello\.txt \(\+1 -1\)/.test(edited) && /MOCK-TOOL-DONE/.test(edited), edited);
check("apply_patch really changed the file in the vfs", after === `${SEEDED} (changed by mock-llm)\n`, after);
await shot("codex-local-apply-patch");
await turn("please write a file");
check("apply_patch can add a file", (await readFile("/home/user/project/mock-output.txt")) === "written by mock-llm\nsecond line\n", await readFile("/home/user/project/mock-output.txt"));

// ---- shell tool: the clean "no shell" error ---------------------------------------
await turn("please use a tool");
const shell = await text();
check("shell tool: a readable 'no shell in this build' tool error, and the turn completes",
  /no shell in this build/.test(shell) && /MOCK-TOOL-DONE/.test(shell) && /exec_command failed/.test(shell), shell);
await shot("codex-local-no-shell");

// ---- persistence, reload, history, resume ------------------------------------------
await page.waitForTimeout(1500);
const saved = await stored();
const rollouts = Object.keys(saved).filter(path => /\/\.codex\/sessions\/.*\.jsonl$/.test(path));
check("IndexedDB holds the project, config, history and the session rollout; no credentials, no SQLite",
  saved["/home/user/project/hello.txt"] > 0 && saved["/home/user/.codex/history.jsonl"] > 0 && rollouts.length >= 1
    && !("/home/user/.codex/auth.json" in saved) && !Object.keys(saved).some(path => path.includes(".sqlite")), Object.keys(saved).filter(path => !path.includes("/skills/")));
await start();
check("after a reload the edited file is still there", (await readFile("/home/user/project/hello.txt")) === `${SEEDED} (changed by mock-llm)\n`);
await press("ArrowUp", 600);
check("after a reload arrow-up recalls the last prompt", /› please use a tool/.test(await text()), await text());
await press("Control+c", 500);
await prompt("/resume");
await page.waitForTimeout(2500);
const picker = await text();
check("/resume lists the session from before the reload", /hello there/.test(picker), picker);
await shot("codex-local-resume-picker");
await press("Enter", 3000);
await waitFor("Ask Codex", 20000).catch(() => {});
const resumed = await text();
check("resuming it replays the earlier transcript", /MOCK-TOOL-DONE|no shell in this build|Hello from mock-llm/.test(resumed), resumed);
await turn("hello again after resume");
check("the resumed session takes another turn", /Hello from mock-llm/.test((await text()).split("hello again after resume").pop() ?? ""), await text());
await shot("codex-local-resumed");
await prompt("/quit");
await page.waitForFunction(() => window.wasmTerm.exit, null, { timeout: 15000 }).catch(() => {});
check("/quit ends the program with code 0", (await exited())?.code === 0, await exited());

// ---- the process seam with a stand-in backend ----------------------------------------
await start("&env=CODEX_WASM_DEMO_SHELL=1");
await turn("please use a tool");
const demo = await text();
check("process seam: an installed backend receives argv, cwd and env, its output and exit code reach the model",
  /Ran echo mock-llm-tool-ok/.test(demo) && /demo-shell: argv=\["\/bin\/sh", "-lc", "echo mock-llm-tool-ok && pwd"\] cwd=\/home\/user\/project/.test(demo.replace(/\n\s*/g, " ")) && /MOCK-TOOL-DONE/.test(demo), demo);

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
if (!SKIP_REAL) {
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
return { passed: checks.length - failures.length, failed: failures.length, load, failures, checks: checks.map(entry => `${entry.ok ? "ok  " : "FAIL"} ${entry.name}`) };
