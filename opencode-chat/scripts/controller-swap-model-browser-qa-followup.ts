// Dedicated real-browser QA for the frozen repaired controller-swap wrapper.
// Local injected model fixture only. Does not build/serve or change app/fixture bytes.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function runWrapper(page: any, options: { origin: string; output: string; cohort: string }, write: (path: string, value: string) => Promise<unknown>) {
  // Kept self-contained so Bun can emit the identical function for visible CLI use.
  const gates: any[] = [], requests: any[] = [], consoleLog: any[] = [], pageErrors: string[] = [], inspections: any[] = [];
  let guardsPassed = 0, checkpointsPassed = 0, failure: string | undefined, activeStep = "initial";
  let root: any;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(`${activeStep}: ${message}`);
    guardsPassed++;
  };
  const keys = (value: any) => value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort().join(",") : "INVALID";
  const modelShape = (raw: string, id: string) => {
    try {
      const body = JSON.parse(raw);
      return keys(body) === "model" && keys(body.model) === "id,providerID" &&
        typeof body.model.id === "string" && typeof body.model.providerID === "string" &&
        body.model.id === id && body.model.providerID === "p";
    } catch { return false; }
  };
  // Concrete regression preflight for the prior JSON-order oracle failure.
  const preflight = {
    providerFirst: modelShape('{"model":{"providerID":"p","id":"m2"}}', "m2"),
    idFirst: modelShape('{"model":{"id":"m2","providerID":"p"}}', "m2"),
    extraOuterRejected: !modelShape('{"model":{"id":"m2","providerID":"p"},"extra":1}', "m2"),
    extraModelRejected: !modelShape('{"model":{"id":"m2","providerID":"p","extra":1}}', "m2"),
    wrongTypeRejected: !modelShape('{"model":{"id":2,"providerID":"p"}}', "m2"),
    wrongValueRejected: !modelShape('{"model":{"id":"m","providerID":"p"}}', "m2"),
  };
  if (!Object.values(preflight).every(Boolean)) throw new Error("semantic oracle preflight failed");
  await write(`${options.output}/oracle-preflight.json`, JSON.stringify(preflight, null, 2));
  page.on("request", (r: any) => requests.push({ url: r.url(), method: r.method(), body: r.postData() }));
  page.on("console", (m: any) => consoleLog.push({ type: m.type(), text: m.text(), location: m.location() }));
  page.on("pageerror", (e: any) => pageErrors.push(String(e)));
  page.setDefaultTimeout(5000);
  const receipt = async () => JSON.parse(await page.getByLabel("QA receipts").textContent());
  const textbox = () => page.getByRole("textbox", { name: "Message OpenCode", exact: true });
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  const model = () => page.getByRole("combobox", { name: "Model", exact: true });
  const capture = async (name: string) => {
    const r = await receipt();
    const gate = { name, receipt: r, text: await textbox().inputValue(),
      actualRootSame: root ? await root.evaluate((e: Element) => e === document.querySelector("section.oc-chat")) : null,
      controls: { sendDisabled: await button("Send ↑").isDisabled(), modelDisabled: await model().isDisabled(),
        newChatDisabled: await button("New chat").isDisabled(), textareaEditable: await textbox().isEditable() },
      storage: await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })) };
    gates.push(gate);
    await write(`${options.output}/gates.json`, JSON.stringify(gates, null, 2));
    await page.screenshot({ path: `${options.output}/${gates.length}-${name}.png`, fullPage: true });
    return gate;
  };
  const waitReady = async () => page.waitForFunction(() => {
    const el = document.querySelector('output[aria-label="QA receipts"]');
    if (!el?.textContent) return false;
    const r = JSON.parse(el.textContent);
    return r.cases.every((c: any) => c.ready || c.readyError) && r.sessionID === "ses1" && !r.pending && !r.loading;
  }, undefined, { timeout: 5000 });
  const waitOperationSettled = async () => page.waitForFunction(() => {
    const r = JSON.parse(document.querySelector('output[aria-label="QA receipts"]')!.textContent!);
    return !r.pending && !r.loading;
  }, undefined, { timeout: 5000 });
  let originalB: string;
  const identity = async (r: any) => {
    check(await root.evaluate((e: Element) => e === document.querySelector("section.oc-chat")), "actual outer DOM reference equality");
    check(r.identity.rootSame && r.identity.rootChanges === 0 && r.identity.profilerMounts === 1, "unkeyed outer root / Profiler identity");
  };
  const noPrompts = (r: any) => check(r.cases.every((c: any) => c.promptCount === 0 && c.unexpectedModelWrites === 0), "zero prompt / unexpected model writes");
  const untouchedB = (r: any) => check(JSON.stringify(r.cases[1]) === originalB, "B fixture unchanged");
  const readySelection = (r: any) => check(r.connection === "connected" && r.execution === "idle" && r.sessionID === "ses1" && !r.loading, "connected idle selected ses1");
  const exactModelWrite = (r: any, count: number, id: string) => {
    const a = r.cases[0];
    const writes = a.writes.filter((w: any) => w.path === "/proxy/api/session/ses1/model");
    check(a.holds === count && a.held && a.unexpectedModelWrites === 0 && writes.length === count, "exact A hold/write count");
    const last = writes[writes.length - 1];
    check(last.method === "POST" && last.path === "/proxy/api/session/ses1/model" && typeof last.body === "string" && modelShape(last.body, id), "exact method/route/semantic body");
    check(modelShape(JSON.stringify(a.heldBody), id), "exact held semantic object");
    untouchedB(r);
  };
  const pendingControls = async () => {
    check(await button("Send ↑").isDisabled(), "pending Send disabled");
    check(await model().isDisabled(), "pending Model disabled / no second admission");
    check(await button("New chat").isDisabled(), "pending New chat disabled");
    check(await textbox().isEditable(), "pending textarea editable");
  };
  const expectedText = "qa-A-current-session-pending";
  try {
    await page.goto(options.origin);
    await waitReady();
    inspections.push({ initialButtons: await page.getByRole("button").allTextContents(), settings: await page.locator("nav[aria-label='Chat settings']").ariaSnapshot() });
    let r = await receipt();
    check(r.cases.length === 2 && r.cases.every((c: any) => c.ready && !c.readyError && !c.held && c.holds === 0 && c.releases === 0 && c.rejects === 0 && c.promptCount === 0 && c.unexpectedModelWrites === 0), "both ready / zero fixture counters");
    check(r.cases.every((c: any) => c.writes.length === 1 && c.writes[0].method === "POST" && c.writes[0].path === "/proxy/api/plugin/await-activation"), "activation only / no model holds");
    readySelection(r); check(!r.pending, "initial not pending");
    originalB = JSON.stringify(r.cases[1]);
    root = await page.locator("section.oc-chat").elementHandle();
    await identity(r); await capture("initial-ready"); checkpointsPassed++;

    activeStep = "A-to-B";
    await textbox().pressSequentially("qa-A-private");
    check(await textbox().inputValue() === "qa-A-private", "A private typed");
    await capture("A-private");
    await button("Controller B").click();
    check(await textbox().inputValue() === "", "B empty / no A leak");
    r = await receipt(); check(r.controller === "B" && !r.pending, "B selected ready"); readySelection(r);
    await identity(r); noPrompts(r); await capture("B-empty"); checkpointsPassed++;

    activeStep = "B-to-A";
    await textbox().pressSequentially("qa-B-private");
    check(await textbox().inputValue() === "qa-B-private", "B private typed");
    await capture("B-private");
    await button("Controller A").click();
    check(await textbox().inputValue() === "", "A empty on return / neither prior draft leaks");
    r = await receipt(); check(r.controller === "A" && !r.pending, "A selected ready"); readySelection(r);
    await identity(r); noPrompts(r); untouchedB(r); await capture("A-return-empty"); checkpointsPassed++;

    activeStep = "model-m2-held";
    await textbox().pressSequentially("qa-A-current-session");
    await page.locator("summary").click();
    inspections.push({ settingsExpanded: await page.locator("nav[aria-label='Chat settings']").ariaSnapshot() });
    await model().click();
    inspections.push({ modelOptions: await page.getByRole("option").allTextContents() });
    await page.getByRole("option", { name: "QA Model Two · p", exact: true }).click();
    r = await receipt(); check(r.pending, "first model pending"); readySelection(r); exactModelWrite(r, 1, "m2");
    check(await textbox().inputValue() === "qa-A-current-session", "model hold preserves draft");
    await pendingControls(); await identity(r); noPrompts(r); await capture("model-m2-held"); checkpointsPassed++;

    activeStep = "pending-enter";
    await textbox().pressSequentially("-pending"); await textbox().press("Enter");
    r = await receipt(); check(await textbox().inputValue() === expectedText, "pending append/Enter exact draft");
    check(r.pending, "still pending after Enter"); exactModelWrite(r, 1, "m2"); noPrompts(r); await pendingControls();
    await capture("pending-enter-zero-prompts"); checkpointsPassed++;

    activeStep = "release";
    await button("Release model mutation").click(); await waitOperationSettled();
    r = await receipt(); check(r.cases[0].holds === 1 && r.cases[0].releases === 1 && r.cases[0].rejects === 0 && !r.cases[0].held && !r.pending, "release counters / settled");
    check(r.model?.id === "m2" && r.model?.providerID === "p", "released model p/m2"); readySelection(r);
    check(await textbox().inputValue() === expectedText, "release preserves draft");
    check(!await button("Send ↑").isDisabled() && !await model().isDisabled() && !await button("New chat").isDisabled(), "Ready controls reenabled");
    noPrompts(r); untouchedB(r); await identity(r); await capture("released-immediate");
    await page.waitForTimeout(300); r = await receipt(); noPrompts(r); untouchedB(r);
    check(await textbox().inputValue() === expectedText, "release interval preserves draft");
    await capture("released-no-auto-prompt"); checkpointsPassed++;

    activeStep = "reverse-model-held";
    await model().click(); inspections.push({ reverseOptions: await page.getByRole("option").allTextContents() });
    await page.getByRole("option", { name: "Model · p", exact: true }).click();
    r = await receipt(); exactModelWrite(r, 2, "m"); check(r.pending, "reverse pending"); readySelection(r);
    check(await textbox().inputValue() === expectedText, "reverse preserves draft"); await pendingControls();
    await textbox().press("Enter"); r = await receipt(); noPrompts(r); exactModelWrite(r, 2, "m");
    check(await textbox().inputValue() === expectedText, "reverse Enter preserves draft");
    await capture("reverse-held-enter"); checkpointsPassed++;

    activeStep = "reject";
    await button("Reject model mutation").click(); await waitOperationSettled();
    r = await receipt(); check(r.cases[0].holds === 2 && r.cases[0].releases === 1 && r.cases[0].rejects === 1 && !r.cases[0].held && !r.pending, "reject counters / recovery");
    check(r.model?.id === "m2" && r.model?.providerID === "p", "rejection keeps last successful model");
    check(typeof r.error === "string" && r.error.includes("QA injected model transport rejection") && await page.getByRole("alert").isVisible(), "recoverable visible injected error");
    check(await textbox().inputValue() === expectedText, "rejection preserves draft"); readySelection(r); noPrompts(r); untouchedB(r);
    check(!await button("Send ↑").isDisabled() && !await model().isDisabled(), "rejection reenabled controls");
    await capture("rejected-immediate"); await page.waitForTimeout(300); r = await receipt(); noPrompts(r); untouchedB(r);
    check(await textbox().inputValue() === expectedText, "rejection interval preserves draft");
    await capture("rejected-no-auto-prompt");
    await button("Dismiss").click(); r = await receipt(); check(!r.error && await page.getByRole("alert").count() === 0, "explicit error dismissal");
    checkpointsPassed++;

    activeStep = "explicit-send";
    await button("Send ↑").click();
    await page.waitForFunction(() => (document.querySelector("textarea") as HTMLTextAreaElement)?.value === "", undefined, { timeout: 5000 });
    r = await receipt(); const prompts = r.cases[0].writes.filter((w: any) => w.path.endsWith("/prompt"));
    check(r.cases[0].promptCount === 1 && prompts.length === 1 && r.cases[1].promptCount === 0, "exactly one A prompt / zero B");
    check(prompts[0].method === "POST" && prompts[0].path === "/proxy/api/session/ses1/prompt" && JSON.parse(prompts[0].body).text === expectedText, "exact intended root session/text prompt");
    check(await textbox().inputValue() === "", "originating composer clears");
    check(r.cases.every((c: any) => c.unexpectedModelWrites === 0) && r.cases[0].holds === 2, "no extra model admissions");
    untouchedB(r); await identity(r); await capture("explicit-send-one-prompt"); checkpointsPassed++;
    check(pageErrors.length === 0, "zero page errors");
    check(requests.every((r: any) => new URL(r.url).origin === new URL(options.origin).origin || r.url.startsWith("chrome-extension://")), "no remote/provider requests");
  } catch (error) {
    failure = String(error);
    // No retry/repair/release; preserve the first failure state.
    try { await capture("first-failure"); } catch (captureError) { inspections.push({ captureError: String(captureError) }); }
  }
  const result = { cohort: options.cohort, origin: options.origin, status: failure ? "STOPPED_NOT_ACCEPTED" : "PASS_LOCAL_FIXTURE_ONLY", guardsPassed, checkpointsPassed, failed: failure ? 1 : 0, activeStep, failure, requests, consoleLog, pageErrors, inspections };
  await write(`${options.output}/result.json`, JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.main) {
  const origin = process.env.QA_ORIGIN;
  const output = process.env.QA_OUTPUT;
  if (!origin || new URL(origin).hostname !== "127.0.0.1" || !output) throw new Error("Fresh owned QA_ORIGIN and QA_OUTPUT required");
  const expected = { "lab.js": "6d0d5dca77986145d93d0f19642fddaf13dba5a460f284459ca123f215f0ec47", "": "95c7bf92d4c6eea13e4dbc3b93e17ab87102103b087896d40c85821a2b5e7a2a" };
  await mkdir(output, { recursive: false }); // refuse existing cohort output
  const hashes: Record<string, string> = {};
  for (const [file, hash] of Object.entries(expected)) {
    const response = await fetch(new URL(file, origin));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    hashes[file || "index.html"] = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (hashes[file || "index.html"] !== hash) throw new Error(`Served hash mismatch: ${file}`);
    await Bun.write(resolve(output, file || "index.html"), bytes);
  }
  await writeFile(resolve(output, "served-hashes.json"), JSON.stringify(hashes, null, 2));
  if (process.argv.includes("--emit-visible")) {
    await writeFile(resolve(output, "visible-execute.js"), `const run = ${runWrapper.toString()}; return await run(page, ${JSON.stringify({ origin, output, cohort: "visible" })}, (path,value)=>fs.promises.writeFile(path,value));`);
    console.log(JSON.stringify({ output, hashes, mode: "visible-code-emitted-no-browser" }));
  } else {
    const modulePath = process.env.QA_PLAYWRIGHT_MODULE;
    const executable = process.env.QA_CHROMIUM_EXECUTABLE;
    if (!modulePath || !executable) throw new Error("Explicit Playwright Core module / real Chromium executable required");
    const { chromium } = await import(modulePath);
    const browser = await chromium.launch({ executablePath: executable, headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, serviceWorkers: "block" });
    const denied: any[] = [];
    const engine = { executable, browserVersion: browser.version(), playwrightVersion: (await Bun.file(resolve(modulePath, "../package.json")).json()).version, ephemeral: true, headless: true };
    let result: any;
    try {
      await context.route("**/*", async (route: any) => {
        if (new URL(route.request().url()).origin !== new URL(origin).origin) {
          denied.push({ url: route.request().url(), method: route.request().method() }); await route.abort();
        } else await route.continue();
      });
      const page = await context.newPage();
      result = await runWrapper(page, { origin, output, cohort: "headless" }, writeFile);
      if (denied.length) result.status = "STOPPED_NOT_ACCEPTED";
    } finally {
      await context.close(); await browser.close();
      await writeFile(resolve(output, "engine-cleanup.json"), JSON.stringify({ ...engine, denied, contextClosed: true, browserClosed: true }, null, 2));
    }
    console.log(JSON.stringify({ ...engine, ...result, denied }));
    if (result?.failed || denied.length) process.exitCode = 1;
  }
}
