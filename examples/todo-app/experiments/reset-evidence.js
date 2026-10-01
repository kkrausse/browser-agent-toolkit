// Browser Control execute body, not a standalone Bun script. One switch per call.
// Caller sets state.resetEvidenceDirectory to a fresh absolute private directory.
if (!state.resetEvidenceDirectory || !path.isAbsolute(state.resetEvidenceDirectory)) throw new Error('Set an absolute resetEvidenceDirectory')
const url = new URL(page.url())
if (!['http://127.0.0.1:43219', 'http://localhost:43219', 'http://127.0.0.1:43220'].includes(url.origin) || url.searchParams.get('fsEvidence') !== '1') throw new Error('Expected isolated phase-1 origin with fsEvidence=1')
const receipt = {url: page.url(), started: new Date().toISOString(), status: 'FAILED', checks: []}
async function verify() {
  const source = await page.evaluate(() => window.editorPerformanceExperiment.verifySource())
  if (url.searchParams.get('services') === 'none') return {...source, workspace: source.generation % 2 ? 'A' : 'B', readiness: 'installed-only, services never started'}
  await page.frameLocator('iframe').getByRole('button', {name: 'Generate fixture PDF'}).click()
  await page.waitForFunction(() => Number(document.querySelector('iframe')?.contentDocument?.querySelector('#pdf-workload')?.dataset.bytes) > 0, null, {timeout: 30000})
  const pdfBytes = Number(await page.frameLocator('iframe').locator('#pdf-workload').getAttribute('data-bytes'))
  return {...source, workspace: source.generation % 2 ? 'A' : 'B', pdfBytes}
}
try {
  await page.waitForFunction(() => window.editorPerformanceExperiment?.ready || window.editorPerformanceExperiment?.error, null, {timeout: 120000})
  const error = await page.evaluate(() => window.editorPerformanceExperiment.error)
  if (error) throw new Error(error) // No recovery/retry of a failed clear.
  receipt.checks.push(await verify())
  if (state.resetEvidenceAction !== 'initial') {
    await page.evaluate(() => window.editorPerformanceExperiment.switchWorkspace())
    receipt.checks.push(await verify())
    if (receipt.checks[1].generation !== receipt.checks[0].generation + 1) throw new Error('Unexpected target generation')
  }
  receipt.status = 'PASS'
} catch (error) { receipt.error = String(error) }
receipt.evidence = await page.evaluate(() => {
  const api = window.editorPerformanceExperiment
  return api ? {ready: api.ready, error: api.error, samples: api.samples, events: api.events, resetEvidence: api.resetEvidence, resources: api.resources()} : {error: 'API absent'}
})
receipt.finished = new Date().toISOString()
fs.mkdirSync(state.resetEvidenceDirectory, {recursive: true})
const output = path.join(state.resetEvidenceDirectory, `reset-${Date.now()}.json`)
fs.writeFileSync(output, JSON.stringify(receipt, null, 2), {flag: 'wx'})
return {status: receipt.status, error: receipt.error, checks: receipt.checks, output}
