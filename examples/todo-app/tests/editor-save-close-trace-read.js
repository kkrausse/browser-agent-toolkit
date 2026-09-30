// CLI read-only evidence export after a completed action, never during Save/close.
const evidence = state.editorTraceEvidence, phase = state.editorTraceReadPhase;
if (typeof evidence !== 'string' || !evidence.includes('/editor-save-close-trace-evidence-') || !['initial', 'after-save', 'after-close'].includes(phase)) throw Error('Require explicit evidence directory and phase');
const catalog = await page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open('todo-browser-workspaces-v1', 1);
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  try {
    const value = await new Promise((resolve, reject) => {
      const r = db.transaction('catalog').objectStore('catalog').get('current');
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    return JSON.stringify(value, (_k, v) => v instanceof Uint8Array ? {type: 'Uint8Array', bytes: [...v]} : v);
  } finally { db.close(); }
});
fs.writeFileSync(evidence + '/catalog-' + phase + '.json', catalog, {flag: 'wx'});
const trace = await page.evaluate(() => globalThis.__editorSaveCloseTrace.read());
fs.writeFileSync(evidence + '/trace-' + phase + '.json', JSON.stringify(trace, (_k, v) => v instanceof Uint8Array ? {type: 'Uint8Array', bytes: [...v]} : v, 2), {flag: 'wx'});
return {phase, catalogBytes: catalog.length, rows: trace.rows.length, dropped: trace.dropped, captureDropped: trace.captureDropped, observerErrors: trace.observerErrors};
