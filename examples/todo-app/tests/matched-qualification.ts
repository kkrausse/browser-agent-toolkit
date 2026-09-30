export interface AuditResult { valid: boolean; checked: number; reason?: string; cacheDigest?: string }
/** Retention and post-replacement exceptions take the same mandatory reset path. */
export async function auditFence(phase: string, inspect: () => Promise<AuditResult>, retained: string | undefined, fallback: () => Promise<never>, record: (result: AuditResult) => void): Promise<AuditResult> {
  let result: AuditResult
  try { result = await inspect() }
  catch (error) {
    if (phase === 'initial') throw error
    result = {valid:false,checked:0,reason:String(error)}
  }
  record(result)
  const trusted = result.valid && (phase === 'initial' || !!result.cacheDigest)
  if (phase === 'after-replacement' && (!trusted || result.cacheDigest !== retained)) return fallback()
  if (!trusted && phase === 'initial') throw Error('Installed tree audit failed: ' + result.reason)
  return {...result,valid:trusted}
}

/** HTTP completion does not grant attachment permission after cancellation. */
export async function previewHTTPThenAttach(signal: AbortSignal, fetch: () => Promise<Response>, attach: () => void): Promise<void> {
  signal.throwIfAborted()
  const response = await fetch()
  if (!response.ok) throw Error(`Preview HTTP ${response.status}`)
  await response.arrayBuffer()
  signal.throwIfAborted()
  attach()
}
