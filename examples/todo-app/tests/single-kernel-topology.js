// Browser Control execute --file, using only this session's fresh-origin page.
// Target.getTargets is observational; never attach/terminate unrelated workers.
const origin = new URL(page.url()).origin;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw Error('Expected owned loopback acceptance origin');
const cdp = await page.context().newCDPSession(page);
try {
  const {targetInfos} = await cdp.send('Target.getTargets');
  const targets = targetInfos.filter(target => target.url?.startsWith(origin + '/') && ['worker', 'shared_worker', 'service_worker'].includes(target.type));
  const workers = targets.filter(target => target.type !== 'service_worker');
  const kernel = workers.filter(target => /\/kernel-worker-[\w-]+\.js(?:\?|$)/.test(target.url));
  const processes = workers.filter(target => /\/process-worker-[\w-]+\.js(?:\?|$)/.test(target.url));
  const diagnostic = await page.evaluate(() => window.singleKernelAcceptance.diagnostics());
  if (kernel.length !== 1 || workers.length !== kernel.length + processes.length) throw Error('Unexpected actual Chrome worker topology: ' + JSON.stringify(targets));
  if (!diagnostic?.workers || diagnostic.workers.process !== processes.length) throw Error('Chrome process targets differ from runtime worker diagnostics');
  return {origin, targets, runtimeWorkers:diagnostic.workers, proof:'Actual Chrome target inventory; service worker relay excluded from runtime authority count'};
} finally { await cdp.detach(); }
