// Browser Control --file. Diagnostic Exit only; runs even after rejected explicit Save.
const evidence = state.editorTraceEvidence;
if (typeof evidence !== 'string' || !evidence.includes('/editor-save-close-trace-evidence-')) throw Error('Require owned evidence directory');
if (!state.editorTraceSaveAttempted || state.editorTraceCloseAttempted) throw Error('Require one prior Save attempt and no prior Exit');
const origin = new URL(page.url()).origin;
const cdp = await page.context().newCDPSession(page);
const events = []; let eventsDropped = 0, discoveryError;
const ownedTargets = new Set();
const onEvent = (method, data) => {
  if (method === 'Target.targetCreated') {
    const target = data.targetInfo;
    if (!(target?.url?.startsWith(origin + '/') || target?.url?.startsWith('blob:' + origin + '/') || ownedTargets.has(target?.openerId))) return;
    ownedTargets.add(target.targetId);
  } else if (!ownedTargets.has(data.targetId)) return;
  if (events.length === 256) { events.shift(); eventsDropped++; }
  events.push({utc: new Date().toISOString(), method, data});
};
cdp.on('Target.targetCreated', data => onEvent('Target.targetCreated', data));
cdp.on('Target.targetDestroyed', data => onEvent('Target.targetDestroyed', data));
let start;
async function bounded(task) {
  let timer;
  try { return await Promise.race([task, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error('Read-only census request exceeded 1000ms; missing evidence')), 1000); })]); }
  finally { clearTimeout(timer); }
}
async function census(label) {
  const began = Date.now();
  try {
    const all = (await bounded(cdp.send('Target.getTargets'))).targetInfos;
    const ids = new Set(all.filter(t => t.url?.startsWith(origin + '/') || t.url?.startsWith('blob:' + origin + '/')).map(t => t.targetId));
    for (let changed = true; changed;) {
      changed = false;
      for (const t of all) if (t.openerId && ids.has(t.openerId) && !ids.has(t.targetId)) { ids.add(t.targetId); changed = true; }
    }
    for (const id of ids) ownedTargets.add(id);
    const locks = await bounded(page.evaluate(() => navigator.locks.query()));
    return { label, utc: new Date().toISOString(), beginElapsedMs: start ? began - start : null,
      endElapsedMs: start ? Date.now() - start : null, targets: all.filter(t => ids.has(t.targetId)), locks };
  } catch (error) { return {label, beginElapsedMs: start ? began - start : null, endElapsedMs: start ? Date.now() - start : null, error: String(error)}; }
}
try {
  try { await bounded(cdp.send('Target.setDiscoverTargets', {discover: true})); } catch (error) { discoveryError = String(error); }
  const before = await census('before-close');
  // Supported SDK editor has no public read-only guest activity probe exposed here.
  const guestActivityProbe = {supported: false, reason: 'No SDK-backed __vv.diag or public controller handle exposed; not injected'};
  state.editorTraceCloseAttempted = true;
  start = Date.now();
  const samples = [];
  const sampling = (async () => {
    while (Date.now() - start < 15000) {
      samples.push(await census('original-15000ms-window'));
      const remaining = 15000 - (Date.now() - start);
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(150, remaining)));
    }
  })();
  let publicCloseError;
  try {
    await page.getByRole('button', {name: 'Exit', exact: true}).click({timeout: 15000});
    const remaining = 15000 - (Date.now() - start);
    if (remaining <= 0) throw Error('Original close UI window already exhausted');
    await page.getByRole('button', {name: 'Open editor', exact: true}).waitFor({state: 'visible', timeout: remaining});
  } catch (error) { publicCloseError = String(error); }
  const uiReceiptElapsedMs = Date.now() - start;
  await sampling;
  const withinWindow = samples.filter(s => s.endElapsedMs <= 15000);
  const result = {origin, before, guestActivityProbe, startedUTC: new Date(start).toISOString(),
    originalDeadlineMs: 15000, uiReceiptElapsedMs, publicCloseError, samples,
    lastCompleteOriginalWindowSample: withinWindow.at(-1) ?? null, discoveryError, events, eventsDropped,
    trace: await page.evaluate(() => globalThis.__editorSaveCloseTrace.read()).catch(error => ({error: String(error)})), aria: await page.locator('body').ariaSnapshot().catch(error => String(error)),
    censusCaveat: 'Extension-mediated targets; terminate return is not a join. Samples ending after 15000ms excluded; gaps/errors are not absence.'};
  fs.writeFileSync(evidence + '/original-close-window.json', JSON.stringify(result, (_k, v) => v instanceof Uint8Array ? {type: 'Uint8Array', bytes: [...v]} : v, 2), {flag: 'wx'});
  // Separate late observation, never counted as original deadline acceptance.
  const remaining = 30000 - (Date.now() - start);
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
  const late = await census('post-window-observation-only');
  fs.writeFileSync(evidence + '/post-window-census.json', JSON.stringify(late, null, 2), {flag: 'wx'});
  return {publicCloseError, uiReceiptElapsedMs, originalSamples: samples.length, lastOriginal: withinWindow.at(-1), late, discoveryError, eventsDropped};
} finally { await cdp.detach(); }
