// Drives the static build of codex-local (ports/codex/scripts/static.sh; web/static.ts) in a real
// browser: a directory of plain files behind a file server that sets no headers, the program's
// requests going from the tab straight to the mock (net=direct), which answers CORS the way
// OpenAI's three hosts did on 2026-10-10 (mock-llm/server.ts). Run through
// ./run.sh codex-static, which supplies:
//   ALLOWED   the directory at an origin on chatgpt.com's (and the mock's) list: http://localhost:8002
//   REFUSED   the same directory at an origin that is not: http://127.0.0.1:8002
//   SUBPATH   the directory below a path, any origin (run.sh starts a file server for it)
//   SERVER_HEADERS  what the file server sent with index.html, from curl
//   REAL      CODEX_STATIC_REAL=1: also a few unauthenticated requests to the real hosts
//             (a device code that nobody approves; one GET each to chatgpt.com and api.openai.com
//             from both origins). No credential, no model call.
//
// Returns { passed, failed, failures, checks, numbers }. Screenshots go to docs/screenshots/.

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: ok ? undefined : detail });
const MOCK = "http://127.0.0.1:4791";

const rows = async () => page.evaluate(() => window.wasmTerm.screen());
const text = async () => (await rows()).join("\n");
const flat = async () => (await text()).replace(/\n\s*/g, " ");
const type = async (value) => { await page.keyboard.type(value, { delay: 12 }); await page.waitForTimeout(250); };
const press = async (key, pause = 300) => { await page.keyboard.press(key); await page.waitForTimeout(pause); };
const waitFor = (needle, timeout = 20000) =>
  page.waitForFunction((value) => window.wasmTerm?.screen().join("\n").includes(value), needle, { timeout });
const focus = () => page.evaluate(() => window.wasmTerm.terminal.focus());
const shot = async (name) => { await page.bringToFront(); return page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const readFile = (path) => page.evaluate((path) => window.wasmTerm.readFile(path), path);
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
/** The page may reload once while its service worker takes over: wait for the launcher or the program on whatever document that leaves. */
const settled = async (what, timeout = 180000) => {
  const until = Date.now() + timeout;
  for (;;) {
    try {
      await page.waitForFunction(what, null, { timeout: Math.max(1000, until - Date.now()) });
      return;
    } catch (error) {
      if (Date.now() >= until || !/context|navigat/i.test(String(error))) throw error;
    }
  }
};
const open = async (base, query = "") => {
  await page.goto(`${base}/?guest=codex-local${query}`);
  await settled(() => window.wasmTerm?.screen().join("").trim() || window.wasmTerm?.exit || document.querySelector("#fatal")?.textContent);
};
const start = async (base, query = "") => {
  await open(base, query);
  await waitFor("Ask Codex", 120000);
  await waitFor("~/project", 30000);
  await focus();
  await page.waitForTimeout(600);
};
const launcher = async (base) => {
  await page.goto(`${base}/`);
  await settled(() => !!document.querySelector('#launcher form input[name="guest"][value="codex-local"]'), 60000);
};
/** mock-llm's record, read from the page (the mock allows every origin on /auth). */
const mock = (path = "/auth/state", method = "GET") =>
  page.evaluate(async ([url, method]) => {
    const response = await fetch(url, { method });
    const body = await response.text();
    try { return JSON.parse(body); } catch { return body; }
  }, [`${MOCK}${path}`, method]);
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
const requests = () => page.evaluate(() => window.wasmTerm.requests);
const notice = () => page.evaluate(() => document.querySelector("#notice")?.textContent ?? "");
/** The ChatGPT sign-in against the mock's fake auth server, up to and including the approval. */
const signIn = async () => {
  await waitFor("Sign in with ChatGPT", 120000);
  await focus();
  await press("Enter", 500);
  await waitFor("MOCK-", 20000);
  const device = await text();
  const code = /MOCK-\d+/.exec(device)?.[0];
  await page.waitForTimeout(2500);
  const polls = (await mock()).logins.at(-1)?.polls;
  await mock(`/auth/codex/device?user_code=${code}`); // the user approving in another tab
  return { device, code, polls };
};
/** The module's one-request probe (main/src/local.rs): a GET with codex's HTTP client, through the same transport. */
const probe = async (base, url, query = "") => {
  await page.goto(`${base}/?guest=codex-local&persist=0&shell=off&env=CODEX_WASM_TLS_PROBE=${encodeURIComponent(url)}${query}`);
  await settled(() => window.wasmTerm?.exit, 120000).catch(() => {});
  return page.evaluate(() => ({ exit: window.wasmTerm.exit?.code, out: window.wasmTerm.screen().filter(Boolean).join(" ").replace(/\s+/g, " "), notice: document.querySelector("#notice")?.textContent ?? "", requests: window.wasmTerm.requests }));
};
// The signed-in model calls on the ChatGPT backend's own path, where the origin list applies (natively: chatgpt.com/backend-api/codex).
const CHATGPT_MODEL = `&arg=-c&arg=${encodeURIComponent('openai_base_url="https://mock-llm.test/backend-api/codex"')}`;
const numbers = {};

try {
await page.setViewportSize({ width: 1200, height: 800 });

// ---- the file server and the launcher ---------------------------------------------------------
check("the file server sends none of the isolation headers and no Content-Encoding (a plain file server)",
  /^HTTP\/1\.[01] 200/.test(SERVER_HEADERS) && !/cross-origin|content-encoding/i.test(SERVER_HEADERS), SERVER_HEADERS);
await launcher(ALLOWED);
const front = await page.evaluate(() => {
  const form = document.querySelector('input[name="guest"][value="codex-local"]').form;
  return {
    isolated: crossOriginIsolated, controlled: !!navigator.serviceWorker.controller, title: document.title,
    fields: Object.fromEntries([...new FormData(form)]), buttons: [...form.querySelectorAll("button")].map(button => button.textContent),
    programs: document.querySelectorAll("#launcher section").length, note: document.querySelector("#launcher p.note")?.textContent ?? "",
  };
});
check("launcher: cross-origin isolated by its own service worker, one program, only the project directory asked for, the run, forget, credentials and import buttons",
  front.isolated && front.controlled && front.programs === 1 && Object.keys(front.fields).sort().join() === "dir,guest"
    && ["Run codex-local", "Forget saved state", "Clear stored credentials", "Import folder", "Import .zip"].every(name => front.buttons.includes(name)), front);
check("launcher at an accepted origin says so", /is one chatgpt\.com accepted requests from/.test(front.note), front.note);
await shot("codex-static-launcher");
const form = page.locator('form:has(input[name="guest"][value="codex-local"])');
await form.getByRole("button", { name: "Forget saved state" }).click();
await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Forgotten"), null, { timeout: 10000 }).catch(() => {});
await mock("/auth/reset", "POST");

await open(ALLOWED, "&net=tunnel");
const refusedNet = await page.evaluate(() => document.querySelector("#fatal")?.textContent ?? "");
check("net=tunnel is refused with a reason: there is no relay behind this page", /net=tunnel is not available on this page/.test(refusedNet), refusedNet);

// ---- start: the module through the service worker, a plain turn, a shell turn ---------------------------
const started = Date.now();
await start(ALLOWED, "&backend=mock");
numbers.startMs = Date.now() - started;
numbers.load = await page.evaluate(() => window.wasmTerm.load);
numbers.module = await page.evaluate(() => performance.getEntriesByType("resource").filter(entry => /codex-[0-9a-f]{16}\.wasm/.test(entry.name)).map(entry => ({ name: entry.name.split("/").pop(), transferred: entry.transferSize, decoded: entry.decodedBodySize }))[0]);
const home = await text();
check("the program starts from static files: banner, project directory, mock model", /OpenAI Codex \(v0\.162\.0\)/.test(home) && /mock-model/.test(home) && /~\/project/.test(home), home);
await turn("hello there");
check("plain prompt: the scripted reply streamed in, fetched by the tab from the mock's own origin", /Hello from mock-llm\. This is a scripted plain-text reply/.test(await text()), await text());
let state = await mock();
const plain = state.modelRequests.at(-1) ?? {};
const seen = (await requests()).filter(entry => entry.url === `${MOCK}/v1/responses`).at(-1) ?? {};
check("the mock got the request from the page's origin, with codex's originator and the browser's own User-Agent (codex's is not settable)",
  plain.origin === ALLOWED && /^codex/.test(plain.originator) && /Mozilla\//.test(plain.userAgent) && !plain.headers.includes("cookie") && !plain.headers.includes("referer"), plain);
check("no relay envelope: codex's headers arrive under their own names", plain.headers.includes("originator") && !plain.headers.some(name => name.startsWith("x-wasm-term-fwd-")), plain.headers);
check("the page saw the response head: status, and of the headers only the readable ones (x-request-id is exposed on this path)",
  seen.status === 200 && seen.headers?.includes("content-type") && seen.headers.includes("x-request-id"), seen);
numbers.requestHeaders = plain.headers;
await turn("shell-read", 90000);
const read = (await flat());
const procs = await page.evaluate(() => window.wasmTerm.program.procs);
check("a turn of six shell commands, their output back to the model", /MOCK-SHELL-READ-DONE/.test(read) && procs.length === 6 && procs.every(proc => proc.status === 0), { procs, read: read.slice(-600) });
await shot("codex-static-shell");
await page.waitForTimeout(1200);
await start(ALLOWED, "&backend=mock");
check("persistence is on by default: history and the project survive a reload", (await stored())["/home/user/.codex/history.jsonl"] > 0 && (await stored())["/home/user/project/hello.txt"] > 0, Object.keys(await stored()).filter(path => !path.includes("/skills/")).slice(0, 20));

// ---- importing files, from the launcher ------------------------------------------------------------
await launcher(ALLOWED);
await form.locator("input.import-zip").setInputFiles(IMPORT_ZIP);
await page.waitForFunction(() => /Imported|failed/.test(document.querySelector("#launcher form output")?.textContent ?? ""), null, { timeout: 15000 }).catch(() => {});
const zipStatus = await form.locator("output").textContent();
await start(ALLOWED, "&backend=mock");
check("launcher: 'Import .zip' puts the archive's files into the project", /Imported 3 files/.test(zipStatus ?? "") && (await readFile("/home/user/project/imported/notes.txt")) === "imported by the verify script\n", zipStatus);

// ---- ChatGPT sign-in at an accepted origin: everything goes, on the backend's own path -----------------------
await mock("/auth/reset", "POST");
await open(ALLOWED, `&backend=mock-auth&reset=1${CHATGPT_MODEL}`);
const login = await signIn();
check("'Sign in with ChatGPT' shows the device-code URL and a code; the TUI polls the token endpoint from the tab", /\/auth\/codex\/device/.test(login.device) && !!login.code && login.polls >= 1, login);
await waitFor("Press enter to continue", 30000).catch(() => {});
check("after approval the TUI reports being signed in", /Signed in with your ChatGPT account|You're in control|Press enter to continue/.test(await text()), await text());
for (let i = 0; i < 3 && !/Ask Codex/.test(await text()); i++) await press("Enter", 1500);
await waitFor("Ask Codex", 30000);
const auth = JSON.parse((await readFile("/home/user/.codex/auth.json")) ?? "{}");
check("tokens are stored in CODEX_HOME/auth.json", auth.auth_mode === "chatgpt" && /^mock-refresh-/.test(auth.tokens?.refresh_token), Object.keys(auth));
await turn("hello there");
state = await mock();
const authed = state.modelRequests.at(-1) ?? {};
check("the signed-in model request went to the ChatGPT backend path as an HTTP stream: bearer token, account id, zstd body, from this origin",
  authed.path === "/backend-api/codex/responses" && /^Bearer mock access-\d+$/.test(authed.authorization) && authed.account === "acct_mock_0001" && authed.contentEncoding === "zstd" && authed.origin === ALLOWED
    && /Hello from mock-llm/.test(await text()), authed);
check("no WebSocket was tried (a browser's cannot carry Authorization)", !state.modelRequests.some(entry => /^ws /.test(entry.path)) && !state.requests.some(entry => /^ws /.test(entry)), state.modelRequests.map(entry => entry.path));
check("the mock's preflight for that path accepted the origin (echoed, with allow-credentials) though the request sent no cookie",
  state.cors.some(entry => entry.preflight && entry.allowed && entry.path === "/backend-api/codex/responses" && entry.origin === ALLOWED) && !authed.headers.includes("cookie"), state.cors);
const hidden = (await requests()).filter(entry => /\/backend-api\/codex\/responses$/.test(entry.url)).at(-1) ?? {};
check("the rate-limit, models-etag and request-id headers the backend sent were not readable, and the turn completed without them",
  hidden.status === 200 && !hidden.headers.some(name => /^x-codex-|^x-models-etag|^x-request-id/.test(name)), hidden);
check("the request was sent to the mock on loopback under its https name (the page's rewrite, mock backends only)", /^http:\/\/127\.0\.0\.1:4791\//.test(hidden.url ?? ""), hidden.url);
check("token refresh and the post-login account check were answered", state.refreshes >= 1 && state.accountChecks.some(entry => entry.status === 200), { refreshes: state.refreshes, checks: state.accountChecks });
numbers.signedInRequestHeaders = authed.headers;
await prompt("/status");
await page.waitForTimeout(2500);
check("/status renders without the rate-limit headers", /Account|Model|Directory/.test(await text()), await text());
await shot("codex-static-signed-in");
await press("Escape", 500);
await page.waitForTimeout(1200);
await start(ALLOWED, `&backend=mock-auth${CHATGPT_MODEL}`);
check("after a reload: still signed in", !/Sign in with ChatGPT/.test(await text()), await text());
await prompt("/logout");
await page.waitForFunction(() => window.wasmTerm.exit, null, { timeout: 20000 }).catch(() => {});
state = await mock();
check("/logout: the token is revoked at the auth server and auth.json is gone", state.revoked.length === 1 && (await readFile("/home/user/.codex/auth.json")) === null, { revoked: state.revoked.length });

// ---- API key ------------------------------------------------------------------------------
await open(ALLOWED, "&backend=mock-auth");
await waitFor("Sign in with ChatGPT", 60000);
await focus();
await press("3", 800);
await page.waitForTimeout(500);
await type("sk-mock-not-a-real-key");
await press("Enter", 2000);
for (let i = 0; i < 3 && !/Ask Codex/.test(await text()); i++) await press("Enter", 1500);
await waitFor("Ask Codex", 30000).catch(() => {});
await turn("hello there");
state = await mock();
check("API key: stored, and the model request carries it as the bearer token, uncompressed", JSON.parse((await readFile("/home/user/.codex/auth.json")) ?? "{}").OPENAI_API_KEY === "sk-mock-not-a-real-key"
  && (state.modelRequests.at(-1)?.authorization ?? "").startsWith("Bearer sk-mock-not-a-rea") && state.modelRequests.at(-1)?.path === "/v1/responses" && state.modelRequests.at(-1)?.contentEncoding === "", state.modelRequests.at(-1));
await page.waitForTimeout(1200);
await launcher(ALLOWED);
await form.getByRole("button", { name: "Clear stored credentials" }).click();
await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Credentials cleared"), null, { timeout: 10000 }).catch(() => {});
check("launcher: 'Clear stored credentials' removes auth.json and keeps the rest", !("/home/user/.codex/auth.json" in (await stored())) && (await stored())["/home/user/.codex/history.jsonl"] > 0, Object.keys(await stored()).filter(path => !path.includes("/skills/")).slice(0, 12));

// ---- an origin the ChatGPT backend refuses ------------------------------------------------------------
await mock("/auth/reset", "POST");
await launcher(REFUSED);
const refusedNote = await page.evaluate(() => document.querySelector("#launcher p.note")?.textContent ?? "");
check("launcher at a refused origin says what will and will not work there, and where to serve it instead", /is not one chatgpt\.com accepts/.test(refusedNote) && /API key works/.test(refusedNote) && /http:\/\/localhost:3000/.test(refusedNote), refusedNote);
await shot("codex-static-refused-launcher");
await open(REFUSED, `&backend=mock-auth&reset=1${CHATGPT_MODEL}`);
const refusedLogin = await signIn();
check("refused origin: the sign-in server still answers (code shown, polls arrive)", !!refusedLogin.code && refusedLogin.polls >= 1, refusedLogin);
await page.waitForFunction(() => !!document.querySelector("#notice"), null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1500);
const refusedNotice = await notice();
const refusedScreen = await text();
state = await mock();
check("refused origin: the account check after the sign-in is stopped by the backend's preflight (400, no allow-origin)",
  state.cors.some(entry => entry.preflight && !entry.allowed && entry.path === "/backend-api/wham/accounts/check" && entry.origin === REFUSED) && !state.accountChecks.some(entry => entry.status === 200), { cors: state.cors, checks: state.accountChecks });
check("refused origin: the page says why and what to do (allowlisted origin, API key, or the tunnel build)",
  /does not accept requests from this page's origin \(http:\/\/127\.0\.0\.1:\d+\)/.test(refusedNotice) && /http:\/\/localhost:3000/.test(refusedNotice) && /API key/.test(refusedNotice) && /tunnel/.test(refusedNotice), refusedNotice);
check("refused origin: the TUI is back at the sign-in choices with an error, not hanging", /Sign in with ChatGPT/.test(refusedScreen) && /fail|error/i.test(refusedScreen), refusedScreen);
await shot("codex-static-refused-signin");
// An API key works from any origin on the API's own path ...
await page.evaluate(() => document.querySelector("#notice")?.remove());
await open(REFUSED, "&backend=mock-auth&signout=1");
await waitFor("Sign in with ChatGPT", 60000);
await focus();
await press("3", 800);
await page.waitForTimeout(500);
await type("sk-mock-not-a-real-key");
await press("Enter", 2000);
for (let i = 0; i < 3 && !/Ask Codex/.test(await text()); i++) await press("Enter", 1500);
await waitFor("Ask Codex", 30000).catch(() => {});
await turn("hello there");
check("refused origin: an API key works (the API host allows every origin)", /Hello from mock-llm/.test(await text()) && !(await notice()), { screen: await text(), notice: await notice() });
await page.waitForTimeout(1200);
// ... and a model call on the ChatGPT backend's path is answered at once, in the TUI, with the reason.
await start(REFUSED, `&backend=mock-auth${CHATGPT_MODEL}`);
await prompt("hello there");
await page.waitForFunction(() => /does not accept requests from this/.test(window.wasmTerm.screen().join(" ").replace(/\s+/g, " ")), null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1500);
const refusedTurn = await flat();
const refusedSeen = (await requests()).filter(entry => /\/backend-api\/codex\/responses$/.test(entry.url));
check("refused origin: a ChatGPT-backend model call shows the reason in the TUI (origin, http://localhost:3000, API key, tunnel) at once: no retry loop, no hang",
  /chatgpt\.com does not accept requests from this page's origin/.test(refusedTurn) && /http:\/\/localhost:3000/.test(refusedTurn) && /tunnel/.test(refusedTurn) && !/esc to interrupt/.test(refusedTurn)
    && refusedSeen.length >= 1 && refusedSeen.length <= 2 && refusedSeen.every(entry => entry.synthetic === true && entry.status === 400), { refusedTurn: refusedTurn.slice(-900), refusedSeen: JSON.stringify(refusedSeen) });
check("refused origin: the notice is on the page too", /does not accept requests/.test(await notice()), await notice());
await shot("codex-static-refused-turn");
await launcher(REFUSED);
await page.locator('form:has(input[name="guest"][value="codex-local"])').getByRole("button", { name: "Forget saved state" }).click();
await page.waitForTimeout(800);

// ---- below a path ------------------------------------------------------------------------------
if (SUBPATH) {
  await launcher(SUBPATH);
  const sub = await page.evaluate(() => ({ isolated: crossOriginIsolated, scope: navigator.serviceWorker.controller?.scriptURL, action: document.querySelector("#launcher form")?.getAttribute("action") }));
  check("below a path: isolated by a worker scoped to the directory, and the launcher submits to the same path", sub.isolated && sub.scope === `${SUBPATH}/sw.js` && sub.action === new URL(`${SUBPATH}/`).pathname, sub);
  await page.locator('#launcher form button[type="submit"]').click();
  await settled(() => /[?&]guest=codex-local/.test(location.search) && (window.wasmTerm?.screen().join("").includes("Sign in with ChatGPT") || window.wasmTerm?.exit), 180000).catch(() => {});
  const subScreen = await text();
  check("below a path: the sign-in screen of the real backend appears (nothing is sent until a choice is made)", /Sign in with ChatGPT/.test(subScreen) && /Provide your own API key/.test(subScreen) && new URL(page.url()).pathname === new URL(`${SUBPATH}/`).pathname, { url: page.url(), subScreen });
  await start(SUBPATH, "&backend=mock&persist=0");
  await turn("hello there");
  check("below a path: a turn against the mock", /Hello from mock-llm/.test(await text()), await text());
}

// ---- the real hosts, unauthenticated ---------------------------------------------------------------
if (REAL) {
  const pageFetch = (url) => page.evaluate(async (url) => {
    try {
      // What the host does for a direct request, with one of codex's headers so that the browser preflights.
      const response = await fetch(url, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", headers: { originator: "codex_cli_rs" } });
      return { status: response.status, headers: [...response.headers.keys()], body: (await response.text()).slice(0, 80) };
    } catch (error) { return { error: String(error) }; }
  }, url);
  const CHATGPT = "https://chatgpt.com/backend-api/codex/models?client_version=0.162.0";
  const API = "https://api.openai.com/v1/models";
  await launcher(ALLOWED);
  const allowedChatgpt = await pageFetch(CHATGPT);
  const allowedApi = await pageFetch(API);
  await launcher(REFUSED);
  const refusedChatgpt = await pageFetch(CHATGPT);
  const refusedApi = await pageFetch(API);
  numbers.real = { allowedChatgpt, allowedApi, refusedChatgpt, refusedApi };
  check("real chatgpt.com from the accepted origin: the preflight passes and the tab reads the answer (401 without a token)", allowedChatgpt.status === 401, allowedChatgpt);
  check("real chatgpt.com from the refused origin: the browser rejects the request", /TypeError/.test(refusedChatgpt.error ?? ""), refusedChatgpt);
  check("real api.openai.com from both origins: 401 without a key, readable", allowedApi.status === 401 && refusedApi.status === 401, { allowedApi, refusedApi });
  const viaModule = await probe(REFUSED, CHATGPT, "&backend=openai");
  check("real chatgpt.com from the refused origin through the module: the page's 400 with the reason, and the notice", /->400/.test(viaModule.out.replace(/\s+/g, "")) && /does not accept requests/.test(viaModule.notice), viaModule);
  const viaModuleAllowed = await probe(ALLOWED, CHATGPT, "&backend=openai");
  check("real chatgpt.com from the accepted origin through the module: 401, no notice", /->401/.test(viaModuleAllowed.out.replace(/\s+/g, "")) && !viaModuleAllowed.notice, viaModuleAllowed);
  numbers.real.chatgptVisibleHeaders = viaModuleAllowed.requests?.at(-1)?.headers;
  // The first, unauthenticated step of a real sign-in: a code appears; nobody approves it.
  await open(ALLOWED, "&signout=1");
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
  check("real auth.openai.com straight from the tab: the device-code URL and a code appear in the TUI (nothing is approved)", outcome === "code", real);
  numbers.real.auth = (await requests()).filter(entry => /auth\.openai\.com/.test(entry.url)).map(entry => `${entry.method} ${entry.url} ${entry.status}`).slice(0, 4);
  await page.bringToFront();
  await press("Escape", 800);
  check("Esc cancels the pending sign-in; nothing was stored", /Sign in with Device Code/.test(await text()) && (await readFile("/home/user/.codex/auth.json")) === null, await text());
}
} catch (error) {
  check("script ran to the end", false, { error: String(error?.stack ?? error), screen: await text().catch(() => null), fatal: await page.evaluate(() => document.querySelector("#fatal")?.textContent).catch(() => null) });
}

const failures = checks.filter(entry => !entry.ok);
return { passed: checks.length - failures.length, failed: failures.length, numbers, failures, checks: checks.map(entry => `${entry.ok ? "ok  " : "FAIL"} ${entry.name}`) };
