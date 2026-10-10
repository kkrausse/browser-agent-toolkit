// Runtime configuration travels in the fragment of the process worker's URL,
// because kerneld (which creates the workers) only knows that URL. The host
// builds it with `processWorkerUrl`.
import { DEFAULT_CONFIG, type RuntimeConfig } from './runtime'

/** URL to pass to `bootKernel({ processWorkerUrl, processWorkerType: 'classic' })`. Relative URLs in `config` are resolved against the script. */
export function processWorkerUrl(scriptUrl: string, config: Partial<RuntimeConfig> = {}): string {
  return `${scriptUrl}#${encodeURIComponent(JSON.stringify(config))}`
}

export function parseConfig(href: string): RuntimeConfig {
  const hash = href.indexOf('#')
  let given: Partial<RuntimeConfig> = {}
  if (hash >= 0 && hash + 1 < href.length) {
    try {
      given = JSON.parse(decodeURIComponent(href.slice(hash + 1)))
    } catch (e) {
      console.warn(`process worker: unreadable configuration in the URL fragment: ${e}`)
    }
  }
  const base = hash >= 0 ? href.slice(0, hash) : href
  const abs = (u: string) => new URL(u, base).href
  const config: RuntimeConfig = { ...DEFAULT_CONFIG, ...given, wasm: { ...DEFAULT_CONFIG.wasm, ...given.wasm }, programs: { ...given.programs } }
  config.nodelibUrl = abs(config.nodelibUrl)
  for (const k of Object.keys(config.wasm)) if (config.wasm[k]) config.wasm[k] = abs(config.wasm[k]!)
  for (const k of Object.keys(config.programs)) config.programs[k] = abs(config.programs[k])
  return config
}
