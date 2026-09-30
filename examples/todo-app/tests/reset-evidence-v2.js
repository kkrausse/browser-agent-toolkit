// Browser Control execute body, prepared with prepare-reset-verifier.ts.
// Caller fixes a fresh origin, private directory, action and unique switch token.
if (!state.resetEvidenceDirectory || !path.isAbsolute(state.resetEvidenceDirectory)) throw Error('Set absolute resetEvidenceDirectory')
const url = new URL(page.url())
if (!state.resetEvidenceOrigin || url.origin !== state.resetEvidenceOrigin || url.searchParams.get('fsEvidence') !== '1') throw Error('Wrong qualification origin')
const receipt = {url: page.url(), started: new Date().toISOString(), status: 'FAILED', stage: 'initial', checks: [], contextReadErrors: []}
async function verify(expectedGeneration) {
  receipt.stage = 'source'
  const source = await page.evaluate(() => window.editorPerformanceExperiment.verifySource())
  if (expectedGeneration !== undefined && source.generation !== expectedGeneration) throw Error(`Unexpected source generation ${source.generation}`)
  if (url.searchParams.get('services') === 'none') return source
  receipt.stage = 'hydration'
  await ResetVerifier.waitForVerificationRead(() => page.evaluate(generation => {
    const api = window.editorPerformanceExperiment
    if (!api || api.error) throw Error(api?.error || 'Experiment API absent')
    const d = document.querySelector('iframe')?.contentDocument
    return !!d?.querySelector(`main[data-hydrated="${generation}"] h1[data-generation="${generation}"]`) && !!d.querySelector('input#title:not(:disabled)')
  }, source.generation), Boolean, {timeoutMs: 30000, onContextError: error => receipt.contextReadErrors.push(error)})
   receipt.stage = 'pdf.arm'
   const pdfToken = `pdf-${source.generation}-${crypto.randomUUID()}`
   await ResetVerifier.armPdfWorkload(page, source.generation, pdfToken)
   receipt.stage = 'pdf.click'
  await page.frameLocator('iframe').getByRole('button', {name: 'Generate fixture PDF'}).click()
  receipt.stage = 'pdf.read'
   const pdf = await ResetVerifier.waitForPdfWorkload(page, source.generation, pdfToken, {timeoutMs: 30000, onContextError: error => receipt.contextReadErrors.push(error)})
   return {...source, pdfBytes: pdf.pdfBytes, pdfRun: pdf}
}
try {
  await page.waitForFunction(() => window.editorPerformanceExperiment?.ready || window.editorPerformanceExperiment?.error, null, {timeout: 120000})
  receipt.checks.push(await verify())
  if (state.resetEvidenceAction !== 'initial') {
    if (!state.resetEvidenceToken) throw Error('Unique switch token required')
    const generation = receipt.checks[0].generation + 1
    receipt.stage = 'switch.initiate'
    receipt.initiation = await ResetVerifier.startWorkspaceSwitch(page, state.resetEvidenceToken)
    receipt.stage = 'switch.observe'
    receipt.completion = await ResetVerifier.waitForWorkspaceSwitch(page, state.resetEvidenceToken, generation, {timeoutMs: 120000, onContextError: error => receipt.contextReadErrors.push(error)})
    receipt.checks.push(await verify(generation))
  }
  if (page.url() !== receipt.url) throw Error('Host document URL changed')
  receipt.stage = 'completed'
  receipt.status = 'PASS'
} catch (error) { receipt.error = String(error) }
// Diagnostic collection cannot erase the original failure receipt.
try {
  receipt.evidence = await page.evaluate(() => {
    const api = window.editorPerformanceExperiment
    return api ? {ready: api.ready, error: api.error, samples: api.samples, events: api.events, resetEvidence: api.resetEvidence, resources: api.resources()} : {error: 'API absent'}
  })
} catch (error) { receipt.evidenceError = String(error) }
receipt.finished = new Date().toISOString()
fs.mkdirSync(state.resetEvidenceDirectory, {recursive: true})
const output = path.join(state.resetEvidenceDirectory, `reset-${Date.now()}.json`)
fs.writeFileSync(output, JSON.stringify(receipt, null, 2), {flag: 'wx'})
return {status: receipt.status, stage: receipt.stage, error: receipt.error, checks: receipt.checks, output}
