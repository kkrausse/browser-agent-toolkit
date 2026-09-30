// Browser Control --file, AFTER fresh-origin activation, New chat, model dropdown inspection.
// Requires state.editorTraceEvidence = NEW directory and Nemotron option visibly open.
const evidence = state.editorTraceEvidence;
if (typeof evidence !== 'string' || !evidence.includes('/editor-save-close-trace-evidence-')) throw Error('Require explicit owned evidence directory');
if (state.editorTraceSaveAttempted) throw Error('One Save already attempted; no retries');
if (!await page.evaluate(() => !!globalThis.__editorSaveCloseTrace)) throw Error('Observer was not installed before boot');
await page.getByRole('option', {name: 'Nemotron 3.5 Lightning Free · opencode', exact: true}).click();
await page.waitForFunction(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent === 'Save workspace'); return b && !b.disabled; }, {}, {timeout: 30000});
await page.getByRole('textbox', {name: 'Workspace name', exact: true}).fill('QA owned A');
await page.evaluate(() => globalThis.__todoWorkspaceFixture.writeSource('/qa-owned-marker.txt', 'editor-A-20260930\n'));
state.editorTraceSaveAttempted = true;
await page.getByRole('button', {name: 'Save workspace', exact: true}).click();
let waitError;
try {
  await page.waitForFunction(() => document.body.textContent.includes('Saved QA owned A locally'), {}, {timeout: 30000});
} catch (error) { waitError = String(error); }
const result = { waitError, utc: new Date().toISOString(), aria: await page.locator('body').ariaSnapshot(),
  trace: await page.evaluate(() => globalThis.__editorSaveCloseTrace.read()) };
fs.writeFileSync(evidence + '/save-once.json', JSON.stringify(result, (_k, v) => v instanceof Uint8Array ? {type: 'Uint8Array', bytes: [...v]} : v, 2), {flag: 'wx'});
return {waitError, aria: result.aria, checkpoints: result.trace.rows.filter(r => r.kind.startsWith('checkpoint.')), dropped: result.trace.dropped};
