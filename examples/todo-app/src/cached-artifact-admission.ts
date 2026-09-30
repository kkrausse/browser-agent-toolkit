/** Preparatory admission only: this is NOT an installed-tree audit or permission
 * to retain an environment. Production switching still clears and redelivers.
 * A future adapter must additionally prove runtime/artifact identity, stopped
 * readers and before/after managed-tree + cache audits. */
export const retainedEnvironmentInputs = [
  '/package.json', '/bun.lock', '/bun.lockb', '/package-lock.json',
  '/pnpm-lock.yaml', '/yarn.lock', '/vite.config.ts', '/vite.config.js',
  '/vite.config.mts', '/vite.config.mjs', '/react-router.config.ts', '/tsconfig.json',
] as const

type Source = Readonly<Record<string, Uint8Array>>
const equal = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
  a === undefined ? b === undefined : b !== undefined && a.length === b.length && a.every((byte, index) => byte === b[index])

/** Require generated inputs to match preparation as well as each other: A/B
 * agreement alone cannot establish compatibility with installed dependencies.
 * Missing optional lock/config files must agree too. Unknown config variants
 * are deliberately not accepted by this first bounded policy. */
export function cachedArtifactSourceAdmission(options: {
  requested: boolean
  retry: boolean
  outgoing: Source
  incoming: Source
  prepared: Source
}): { eligible: boolean; reason: string } {
  if (!options.requested) return { eligible: false, reason: 'disabled' }
  if (options.retry) return { eligible: false, reason: 'interrupted switch requires conservative replacement' }
  if (!options.prepared['/package.json']) return { eligible: false, reason: 'missing prepared package.json' }
  const known = new Set<string>(retainedEnvironmentInputs)
  for (const source of [options.prepared, options.outgoing, options.incoming]) {
    for (const path of Object.keys(source)) {
      if (/^\/(?:vite|react-router)\.config\./.test(path) && !known.has(path)) {
        return { eligible: false, reason: 'unproven configuration input: ' + path }
      }
    }
  }
  for (const path of retainedEnvironmentInputs) {
    if (!equal(options.prepared[path], options.outgoing[path]) || !equal(options.prepared[path], options.incoming[path])) {
      return { eligible: false, reason: 'prepared environment input mismatch: ' + path }
    }
  }
  return { eligible: true, reason: 'source inputs only; ownership, identity and audits still required' }
}
