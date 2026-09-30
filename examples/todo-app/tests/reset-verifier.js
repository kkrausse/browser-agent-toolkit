// Verification only: never retry starting a switch, deletion, click, or PDF job.
// Long promises must live in the page, not in a >60s debugger command.
export async function startWorkspaceSwitch(page, token) {
  return page.evaluate(token => {
    const api = window.editorPerformanceExperiment
    if (!api || api.error) throw new Error(api?.error || 'Experiment API absent')
    const operations = window.resetVerificationOperations ??= {}
    if (operations[token]) throw new Error(`Switch token already used: ${token}`)
    const operation = operations[token] = {status: 'pending', error: ''}
    // Return immediately; both settlement handlers are retained by the host document.
    Promise.resolve().then(() => api.switchWorkspace()).then(
      () => { operation.status = 'completed' },
      error => { operation.status = 'failed'; operation.error = String(error) },
    )
    return {token, status: operation.status}
  }, token)
}

// The unchanged matched fixture writes bytes only after await runPdfWorkload().
// Arm one run on the exact hydrated button, removing any previous completion.
// A timeout leaves the run pending: neither the click nor the workload is retried.
export async function armPdfWorkload(page, generation, token) {
  return page.evaluate(({generation, token}) => {
    const api = window.editorPerformanceExperiment
    if (!api || api.error) throw new Error(api?.error || 'Experiment API absent')
    const d = document.querySelector('iframe')?.contentDocument
    const button = d?.querySelector('#pdf-workload')
    if (!d?.querySelector(`main[data-hydrated="${generation}"] h1[data-generation="${generation}"]`) || !button) throw new Error('PDF generation not hydrated')
    const runs = window.resetPdfVerificationRuns ??= {}
    if (runs[token] || Object.values(runs).some(run => run.status === 'pending')) throw new Error('PDF run already used or pending')
    delete button.dataset.bytes
    button.dataset.verificationRun = token
    runs[token] = {generation, button, document: d, status: 'pending'}
    return {generation, token, status: 'armed'}
  }, {generation, token})
}

export async function waitForPdfWorkload(page, generation, token, options) {
  const url = page.url()
  return waitForVerificationRead(async () => {
    if (page.url() !== url) throw new Error('Host document URL changed')
    return page.evaluate(({generation, token}) => {
      const api = window.editorPerformanceExperiment
      if (!api || api.error) throw new Error(api?.error || 'Experiment API absent')
      const run = window.resetPdfVerificationRuns?.[token]
      if (!run || run.generation !== generation) throw new Error('PDF run observation lost')
      const d = document.querySelector('iframe')?.contentDocument
      if (d !== run.document || d?.querySelector('#pdf-workload') !== run.button || run.button.dataset.verificationRun !== token) throw new Error('PDF run document or token changed')
      const hydrated = !!d.querySelector(`main[data-hydrated="${generation}"] h1[data-generation="${generation}"]`) && !!d.querySelector('input#title:not(:disabled)')
      const pdfBytes = Number(run.button.dataset.bytes)
      if (hydrated && Number.isFinite(pdfBytes) && pdfBytes > 0) run.status = 'completed'
      return {generation, token, status: run.status, pdfBytes, hydrated}
    }, {generation, token})
  }, result => result.status === 'completed' && result.hydrated && result.pdfBytes > 0, options)
}

export async function waitForVerificationRead(read, accept, {
  timeoutMs = 120000, intervalMs = 100, maxContextErrors = 3,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onContextError = () => {},
} = {}) {
  const deadline = now() + timeoutMs
  let contextErrors = 0
  while (now() < deadline) {
    let observation
    try { observation = await read() } catch (error) {
      // Narrowly allow a fresh read across document replacement. Permission, closed
      // target, timeout and runtime errors remain terminal. Never replay an action.
      if (!/^Error: page\.evaluate: Execution context was destroyed, most likely because of a navigation\.$/.test(String(error)) || ++contextErrors > maxContextErrors) throw error
      onContextError(String(error))
      await sleep(Math.min(intervalMs, Math.max(0, deadline - now())))
      continue
    }
    if (now() >= deadline) break
    if (accept(observation)) return observation
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())))
  }
  throw new Error('Generation-specific verification deadline exceeded')
}

export async function waitForWorkspaceSwitch(page, token, expectedGeneration, options) {
  const url = page.url()
  return waitForVerificationRead(async () => {
    if (page.url() !== url) throw new Error('Host document URL changed')
    return page.evaluate(({token, expectedGeneration}) => {
      const api = window.editorPerformanceExperiment
      const operation = window.resetVerificationOperations?.[token]
      if (!api || !operation) throw new Error('Switch observation lost with host document')
      if (api.error || operation.status === 'failed') throw new Error(api.error || operation.error)
      const document = window.document.querySelector('iframe')?.contentDocument
      const hydrated = !!document?.querySelector(`main[data-hydrated="${expectedGeneration}"] h1[data-generation="${expectedGeneration}"]`)
        && !!document.querySelector('input#title:not(:disabled)')
      return {status: operation.status, ready: api.ready, hydrated, installOnly: api.installOnly === true}
    }, {token, expectedGeneration})
  }, observation => observation.status === 'completed' && observation.ready && (observation.installOnly || observation.hydrated), options)
}
