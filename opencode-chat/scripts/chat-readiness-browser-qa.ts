// Independent real-Chromium regression against an already frozen, fresh stub lab.
// Does not start servers, use a user profile, modify the fixture, or call providers.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const origin = process.env.QA_ORIGIN;
if (!origin || new URL(origin).hostname !== "127.0.0.1") throw new Error("QA_ORIGIN must be an owned loopback lab");
const modulePath = process.env.QA_PLAYWRIGHT_MODULE ?? "playwright-core";
const { chromium } = await import(modulePath);
const output = resolve(process.env.QA_OUTPUT ?? "chat-readiness-browser-evidence");
await mkdir(output, { recursive: true });
const bytes = await (await fetch(new URL("lab.js", origin))).arrayBuffer();
const bundleHash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
if (process.env.QA_BUNDLE_SHA256) assert.equal(bundleHash, process.env.QA_BUNDLE_SHA256);
const browser = await chromium.launch({
  ...(process.env.QA_CHROMIUM_EXECUTABLE ? { executablePath: process.env.QA_CHROMIUM_EXECUTABLE } : { channel: "chrome" }),
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
const page = await context.newPage();
page.setDefaultTimeout(5000);
const requests: unknown[] = [], errors: string[] = [], gates: unknown[] = [];
let failure: string | undefined;
let passed = 0;
page.on("request", (r: any) => requests.push({ url: r.url(), method: r.method() }));
page.on("pageerror", (e: Error) => errors.push(String(e)));
page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
await context.route("**/*", async (route: any) => {
  if (new URL(route.request().url()).origin !== new URL(origin).origin) {
    errors.push(`UNAUTHORIZED NETWORK: ${route.request().url()}`);
    await route.abort();
  } else await route.continue();
});
const read = () => page.evaluate(() => ({
  counters: JSON.parse(document.querySelector("output")!.textContent!),
  text: (document.querySelector("textarea") as HTMLTextAreaElement)?.value,
  controls: [...document.querySelectorAll("button,select")].map(e => ({
    text: e.textContent, label: e.getAttribute("aria-label"), disabled: (e as HTMLButtonElement).disabled,
  })),
  status: document.querySelector('[role="status"]')?.textContent,
  localStorageKeys: Object.keys(localStorage), sessionStorageKeys: Object.keys(sessionStorage),
}));
const gate = async (name: string) => {
  const value = await read();
  gates.push({ name, ...value });
  await page.screenshot({ path: resolve(output, `${gates.length}-${name}.png`), fullPage: true });
  await writeFile(resolve(output, "gates.json"), JSON.stringify(gates, null, 2));
  return value;
};
const textbox = () => page.getByRole("textbox", { name: "Message OpenCode" });
const button = (name: string) => page.getByRole("button", { name, exact: true });
const settle = async (predicate: (value: any) => boolean) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (predicate(await read())) return; await Bun.sleep(25); }
  throw new Error(`Gate did not settle: ${JSON.stringify(await read())}`);
};
try {
  await page.goto(origin);
  await settle(v => v.counters.sessionID === "ses1" && !v.counters.loading);
  await gate("initial");
  // Deliberately ordinary locators/input: no global repair, forced click, or DOM mutation.
  await textbox().pressSequentially("qa-old-first");
  await page.locator("summary").click();
  await button("New chat").click();
  await textbox().pressSequentially("qa-new-intended");
  const pending = await gate("creation-pending");
  assert.equal(pending.counters.sessionID, null);
  assert.equal(pending.counters.pending, true);
  assert.equal(pending.counters.promptCount, 0);
  assert.equal(pending.text, "qa-new-intended");
  assert.ok(await button("Send ↑").isDisabled());
  assert.ok(await button("New chat").isDisabled());
  assert.ok(await page.getByLabel("Model", { exact: true }).isDisabled());
  await textbox().press("Enter");
  assert.equal((await read()).counters.promptCount, 0);
  passed++;
  await button("Release creation").click();
  await settle(v => v.counters.sessionID === "ses_lab_1");
  const hydration = await gate("hydration-pending");
  assert.equal(hydration.counters.draftKey, pending.counters.draftKey);
  assert.equal(hydration.text, pending.text);
  assert.ok(await button("Send ↑").isDisabled());
  await textbox().press("Enter");
  assert.equal((await read()).counters.promptCount, 0);
  passed++;
  await button("Release hydration").click();
  await settle(v => !v.counters.pending && !v.counters.loading);
  const ready = await gate("ready-no-automatic-send");
  assert.equal(ready.counters.promptCount, 0);
  assert.equal(ready.text, pending.text);
  await button("Send ↑").click();
  await settle(v => v.counters.promptCount === 1 && v.text === "");
  const sent = await gate("explicit-send");
  assert.deepEqual(sent.counters.prompts, [{ path: "/proxy/api/session/ses_lab_1/prompt", text: "qa-new-intended" }]);
  passed++;
  await button("New chat").click();
  await textbox().pressSequentially("qa-retry-intended");
  await button("Reject creation").click();
  await settle(v => !v.counters.pending);
  const rejected = await gate("rejected-create");
  assert.equal(rejected.text, "qa-retry-intended");
  assert.equal(rejected.counters.sessionID, null);
  assert.equal(rejected.counters.promptCount, 1);
  assert.ok(await button("Send ↑").isDisabled());
  await button("New chat").click();
  await button("Release creation").click();
  await settle(v => v.counters.sessionID === "ses_lab_3");
  await button("Release hydration").click();
  await settle(v => !v.counters.pending && !v.counters.loading);
  const retry = await gate("retry-ready");
  assert.equal(retry.text, rejected.text);
  assert.equal(retry.counters.draftKey, rejected.counters.draftKey);
  assert.equal(retry.counters.promptCount, 1);
  passed++;
  await button("New chat").click();
  await textbox().pressSequentially("qa-abandoned");
  await page.getByLabel("Session", { exact: true }).click();
  await page.getByRole("option", { name: "Second", exact: true }).click();
  await settle(v => v.counters.sessionID === "ses2" && !v.counters.loading);
  await textbox().pressSequentially("qa-second-only");
  await button("Release creation").click();
  await settle(v => !v.counters.pending);
  const abandoned = await gate("late-create-no-hijack");
  assert.equal(abandoned.counters.sessionID, "ses2");
  assert.equal(abandoned.text, "qa-second-only");
  assert.equal(abandoned.counters.promptCount, 1);
  await page.getByLabel("Session", { exact: true }).click();
  await page.getByRole("option", { name: "First", exact: true }).click();
  await settle(v => v.counters.sessionID === "ses1" && !v.counters.loading);
  assert.equal((await gate("revisit-first")).text, "qa-old-first");
  passed++;
  const other = await context.newPage();
  await other.goto(origin);
  await other.getByRole("textbox", { name: "Message OpenCode" }).waitFor();
  assert.equal(await other.getByRole("textbox").inputValue(), "");
  assert.equal((await read()).text, "qa-old-first");
  await other.close();
  passed++;
} catch (error) {
  failure = String(error);
  try { await gate("first-failure"); } catch (captureError) { errors.push(`Capture: ${captureError}`); }
} finally {
  await writeFile(resolve(output, "result.json"), JSON.stringify({ origin, bundleHash, browserVersion: browser.version(), passed, failure, requests, errors, gates }, null, 2));
  await context.close();
  await browser.close();
}
console.log(JSON.stringify({ passed, failure, output, bundleHash }));
if (failure) process.exitCode = 1;
