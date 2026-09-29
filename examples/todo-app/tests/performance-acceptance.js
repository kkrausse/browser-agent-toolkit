// Browser Control execute body. Navigate to the isolated benchmark first.
await page.waitForFunction(() => window.editorPerformanceExperiment?.ready || window.editorPerformanceExperiment?.error, null, {timeout: 120000})
const error = await page.evaluate(() => window.editorPerformanceExperiment.error)
if (error) throw new Error(error)
async function pdf() {
  await page.frameLocator('iframe').getByRole('button', {name: 'Generate fixture PDF'}).click()
  await page.waitForFunction(() => Number(document.querySelector('iframe')?.contentDocument?.querySelector('#pdf-workload')?.dataset.bytes) > 0, null, {timeout: 30000})
  return Number(await page.frameLocator('iframe').locator('#pdf-workload').getAttribute('data-bytes'))
}
const initial = await page.evaluate(() => window.editorPerformanceExperiment.verifySource())
const initialPdfBytes = await pdf()
await page.evaluate(() => window.editorPerformanceExperiment.switchWorkspace())
const target = await page.evaluate(() => window.editorPerformanceExperiment.verifySource())
if (target.generation !== initial.generation + 1) throw new Error('Stale target generation')
const targetPdfBytes = await pdf()
return {url: page.url(), initial, target, initialPdfBytes, targetPdfBytes,
  samples: await page.evaluate(() => window.editorPerformanceExperiment.samples)}
