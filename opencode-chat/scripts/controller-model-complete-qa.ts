// Independent frozen-wrapper acceptance. No app/controller mutation substitutes for UI.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function run(page: any, options: any, write: any) {
  const gates: any[] = [], inspections: any[] = [], requests: any[] = [], errors: any[] = [], consoleLog: any[] = [];
  let guards = 0, checkpoints = 0, step = "ready", failure: any, root: any, originalB: string;
  const check = (ok: any, why: string) => { if (!ok) throw Error(`${step}: ${why}`); guards++; };
  const keys = (o: any) => o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).sort().join(",") : "INVALID";
  const shape = (raw: string, id: string) => { try { const o = JSON.parse(raw); return keys(o) === "model" && keys(o.model) === "id,providerID" && typeof o.model.id === "string" && typeof o.model.providerID === "string" && o.model.id === id && o.model.providerID === "p"; } catch { return false; } };
  const preflight = [shape('{"model":{"providerID":"p","id":"m2"}}', "m2"), shape('{"model":{"id":"m2","providerID":"p"}}', "m2"), !shape('{"model":{"id":"m2","providerID":"p"},"extra":1}', "m2"), !shape('{"model":{"id":"m2","providerID":"p","extra":1}}', "m2"), !shape('{"model":{"id":2,"providerID":"p"}}', "m2"), !shape('{"model":{"id":"m","providerID":"p"}}', "m2")];
  if (!preflight.every(Boolean)) throw Error("oracle preflight");
  await write(`${options.output}/oracle-preflight.json`, JSON.stringify(preflight));
  page.setDefaultTimeout(5000);
  page.on("request", (r: any) => requests.push({ url: r.url(), method: r.method(), body: r.postData() }));
  page.on("pageerror", (e: any) => errors.push(String(e)));
  page.on("console", (m: any) => consoleLog.push({ type: m.type(), text: m.text() }));
  const receipt = async () => JSON.parse(await page.getByLabel("QA receipts").textContent());
  const text = () => page.getByRole("textbox", { name: "Message OpenCode", exact: true });
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  const model = () => page.getByRole("combobox", { name: "Model", exact: true });
  // Hidden role queries are forbidden when native details is collapsed.
  const capture = async (name: string) => {
    const settingsExpanded = await page.locator("details.oc-settings").evaluate((e: HTMLDetailsElement) => e.open);
    const controls = settingsExpanded ? { modelDisabled: await model().isDisabled(), newChatDisabled: await button("New chat").isDisabled() } : { controlsNotQueried: true };
    const g = { name, receipt: await receipt(), text: await text().inputValue(), settingsExpanded, controls: { ...controls, sendDisabled: await button("Send ↑").isDisabled(), textareaEditable: await text().isEditable() }, actualRootSame: root ? await root.evaluate((e: Element) => e === document.querySelector("section.oc-chat")) : null };
    gates.push(g); await write(`${options.output}/gates.json`, JSON.stringify(gates, null, 2));
    await text().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${options.output}/${gates.length}-${name}.png`, fullPage: false });
  };
  const idle = async () => page.waitForFunction(() => { const r = JSON.parse(document.querySelector('output[aria-label="QA receipts"]')!.textContent!); return !r.pending && !r.loading; });
  const selected = (r: any) => check(r.connection === "connected" && r.execution === "idle" && r.sessionID === "ses1" && !r.loading, "selected connected idle ses1");
  const identity = async (r: any) => { check(await root.evaluate((e: Element) => e === document.querySelector("section.oc-chat")), "actual outer DOM equality"); check(r.identity.rootSame && r.identity.rootChanges === 0 && r.identity.profilerMounts === 1, "root/Profiler identity"); };
  const zero = (r: any) => check(r.cases.every((c: any) => c.promptCount === 0 && c.unexpectedModelWrites === 0), "zero prompts/unexpected models");
  const bSame = (r: any) => check(JSON.stringify(r.cases[1]) === originalB, "B untouched");
  const held = (r: any, n: number, id: string) => { const a = r.cases[0], writes = a.writes.filter((w: any) => w.path === "/proxy/api/session/ses1/model"); check(r.pending && a.held && a.holds === n && writes.length === n && a.unexpectedModelWrites === 0, "pending exact hold count"); const w = writes.at(-1); check(w.method === "POST" && shape(w.body, id) && shape(JSON.stringify(a.heldBody), id), "exact POST semantic body"); bSame(r); selected(r); };
  const pendingControls = async () => { check(await button("Send ↑").isDisabled(), "Send disabled"); check(await model().isDisabled(), "Model disabled"); check(await button("New chat").isDisabled(), "New chat disabled"); check(await text().isEditable(), "textarea editable"); };
  const draft = "qa-A-current-session-pending";
  try {
    await page.goto(options.origin);
    await page.waitForFunction(() => { const e = document.querySelector('output[aria-label="QA receipts"]'); if (!e?.textContent) return false; const r = JSON.parse(e.textContent); return r.cases.every((c: any) => c.ready || c.readyError) && !r.loading && !r.pending && r.sessionID === "ses1"; });
    inspections.push({ initial: await page.locator("section.oc-chat").ariaSnapshot() });
    let r = await receipt();
    check(r.cases.length === 2 && r.cases.every((c: any) => c.ready && !c.readyError && !c.held && c.holds === 0 && c.releases === 0 && c.rejects === 0 && c.promptCount === 0 && c.unexpectedModelWrites === 0), "both ready zero counters");
    check(r.cases.every((c: any) => c.writes.length === 1 && c.writes[0].method === "POST" && c.writes[0].path === "/proxy/api/plugin/await-activation"), "activation completed not held");
    selected(r); check(!r.pending, "initial pending false"); originalB = JSON.stringify(r.cases[1]); root = await page.locator("section.oc-chat").elementHandle();
    await identity(r); await capture("ready"); checkpoints++;
    step = "A-B"; await text().pressSequentially("qa-A-private"); check(await text().inputValue() === "qa-A-private", "A private"); await capture("A-private");
    await button("Controller B").click(); check(await text().inputValue() === "", "B empty"); r = await receipt(); check(r.controller === "B" && !r.pending, "B selected"); selected(r); await identity(r); zero(r); await capture("B-empty"); checkpoints++;
    step = "B-A"; await text().pressSequentially("qa-B-private"); check(await text().inputValue() === "qa-B-private", "B private"); await capture("B-private");
    await button("Controller A").click(); check(await text().inputValue() === "", "A return empty"); r = await receipt(); check(r.controller === "A" && !r.pending, "A selected"); selected(r); await identity(r); zero(r); bSame(r); await capture("A-empty"); checkpoints++;
    step = "m2-held"; await text().pressSequentially("qa-A-current-session"); await page.locator("summary").click();
    inspections.push({ expanded: await page.locator("nav[aria-label='Chat settings']").ariaSnapshot() }); await model().click(); inspections.push({ options: await page.getByRole("option").allTextContents() }); await page.getByRole("option", { name: "QA Model Two · p", exact: true }).click();
    r = await receipt(); held(r, 1, "m2"); check(await text().inputValue() === "qa-A-current-session", "hold preserves text"); await pendingControls(); await identity(r); zero(r); await capture("m2-held"); checkpoints++;
    step = "pending-Enter"; await text().pressSequentially("-pending"); await text().press("Enter"); r = await receipt(); check(await text().inputValue() === draft, "append/Enter preserves text"); held(r, 1, "m2"); zero(r); await pendingControls(); await capture("pending-Enter"); checkpoints++;
    step = "release"; await button("Release model mutation").click(); await idle(); r = await receipt();
    check(r.cases[0].holds === 1 && r.cases[0].releases === 1 && r.cases[0].rejects === 0 && !r.cases[0].held && !r.pending, "released settled counts"); check(r.model?.id === "m2" && r.model?.providerID === "p", "chosen m2"); selected(r); check(await text().inputValue() === draft, "release text intact"); check(!await button("Send ↑").isDisabled() && !await model().isDisabled() && !await button("New chat").isDisabled(), "ready controls"); zero(r); bSame(r); await identity(r); await capture("released-immediate");
    await page.waitForTimeout(300); r = await receipt(); zero(r); bSame(r); check(await text().inputValue() === draft, "release interval text"); await capture("released-no-auto"); checkpoints++;
    step = "reverse-held"; await model().click(); inspections.push({ reverseOptions: await page.getByRole("option").allTextContents() }); await page.getByRole("option", { name: "Model · p", exact: true }).click(); r = await receipt(); held(r, 2, "m"); check(await text().inputValue() === draft, "reverse text"); await pendingControls(); await text().press("Enter"); r = await receipt(); zero(r); held(r, 2, "m"); check(await text().inputValue() === draft, "reverse Enter text"); await capture("reverse-held"); checkpoints++;
    step = "reject"; await button("Reject model mutation").click(); await idle(); r = await receipt(); check(r.cases[0].holds === 2 && r.cases[0].releases === 1 && r.cases[0].rejects === 1 && !r.cases[0].held && !r.pending, "reject settled counts"); check(r.model?.id === "m2" && r.model?.providerID === "p", "last successful m2"); check(typeof r.error === "string" && r.error.includes("QA injected model transport rejection") && await page.getByRole("alert").isVisible(), "visible recoverable error"); check(await text().inputValue() === draft, "reject text intact"); selected(r); zero(r); bSame(r); check(!await button("Send ↑").isDisabled() && !await model().isDisabled(), "reject controls recover"); await capture("rejected-immediate");
    await page.waitForTimeout(300); r = await receipt(); zero(r); bSame(r); check(await text().inputValue() === draft, "reject interval text"); await capture("rejected-no-auto"); await button("Dismiss").click(); r = await receipt(); check(!r.error && await page.getByRole("alert").count() === 0, "UI dismissal"); checkpoints++;
    step = "explicit-Send"; await button("Send ↑").click(); await page.waitForFunction(() => (document.querySelector("textarea") as HTMLTextAreaElement)?.value === ""); r = await receipt(); const prompts = r.cases[0].writes.filter((w: any) => w.path.endsWith("/prompt"));
    check(r.cases[0].promptCount === 1 && prompts.length === 1 && r.cases[1].promptCount === 0, "one A zero B prompts"); check(prompts[0].method === "POST" && prompts[0].path === "/proxy/api/session/ses1/prompt" && JSON.parse(prompts[0].body).text === draft, "exact ses1/current text"); check(await text().inputValue() === "", "composer clears"); check(r.cases.every((c: any) => c.unexpectedModelWrites === 0) && r.cases[0].holds === 2, "no extra admissions"); bSame(r); await identity(r); await capture("explicit-Send"); checkpoints++;
    check(errors.length === 0, "zero page errors"); check(requests.every((r: any) => new URL(r.url).origin === new URL(options.origin).origin || r.url.startsWith("chrome-extension://")), "no remote provider requests");
  } catch (e) {
    failure = String(e);
    // First-failure preservation deliberately avoids ALL control role queries.
    try { await write(`${options.output}/first-failure.json`, JSON.stringify({ reason: failure, receipt: await receipt(), dom: await page.locator("section.oc-chat").textContent() }, null, 2)); } catch (e) { inspections.push({ preservationReadError: String(e) }); }
    try { await page.screenshot({ path: `${options.output}/first-failure.png`, fullPage: false }); } catch (e) { inspections.push({ preservationScreenshotError: String(e) }); }
  }
  const result = { cohort: options.cohort, origin: options.origin, status: failure ? "STOPPED_NOT_ACCEPTED" : "PASS_LOCAL_FIXTURE_ONLY", guards, checkpoints, failure, step, gates: gates.length, requests, errors, consoleLog, inspections };
  await write(`${options.output}/result.json`, JSON.stringify(result, null, 2)); return result;
}

if (import.meta.main) {
  const origin = process.env.QA_ORIGIN!, output = process.env.QA_OUTPUT!;
  if (!origin || new URL(origin).hostname !== "127.0.0.1" || !output) throw Error("owned origin/output required");
  await mkdir(output, { recursive: false });
  const hashes: any = {};
  for (const [file, expected] of Object.entries({ "lab.js": "6d0d5dca77986145d93d0f19642fddaf13dba5a460f284459ca123f215f0ec47", "": "95c7bf92d4c6eea13e4dbc3b93e17ab87102103b087896d40c85821a2b5e7a2a" })) {
    const response = await fetch(new URL(file, origin)); if (!response.ok) throw Error(`HTTP ${response.status}`); const bytes = new Uint8Array(await response.arrayBuffer()); const name = file || "index.html";
    hashes[name] = new Bun.CryptoHasher("sha256").update(bytes).digest("hex"); if (hashes[name] !== expected) throw Error(`hash mismatch ${name}`); await Bun.write(resolve(output, name), bytes);
  }
  await writeFile(resolve(output, "served-hashes.json"), JSON.stringify(hashes, null, 2));
  if (process.argv.includes("--emit-visible")) {
    await writeFile(resolve(output, "visible-execute.js"), `const run = ${run.toString()}; return await run(page, ${JSON.stringify({ origin, output, cohort: "visible" })}, (path,value)=>fs.promises.writeFile(path,value));`);
    console.log(JSON.stringify({ output, hashes }));
  } else {
    const modulePath = process.env.QA_PLAYWRIGHT_MODULE!, executable = process.env.QA_CHROMIUM_EXECUTABLE!;
    const { chromium } = await import(modulePath); const browser = await chromium.launch({ executablePath: executable, headless: true }); const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, serviceWorkers: "block" }); const denied: any[] = [];
    const engine = { executable, browserVersion: browser.version(), playwrightVersion: (await Bun.file(resolve(modulePath, "../package.json")).json()).version, ephemeral: true };
    let result: any;
    try { await context.route("**/*", async (route: any) => { if (new URL(route.request().url()).origin !== new URL(origin).origin) { denied.push(route.request().url()); await route.abort(); } else await route.continue(); }); result = await run(await context.newPage(), { origin, output, cohort: "headless" }, writeFile); }
    finally { await context.close(); await browser.close(); await writeFile(resolve(output, "engine-cleanup.json"), JSON.stringify({ ...engine, denied, contextClosed: true, browserClosed: true }, null, 2)); }
    console.log(JSON.stringify({ ...engine, ...result, denied })); if (result?.failure || denied.length) process.exitCode = 1;
  }
}
