// import vite and resolve the TODO project's config (cwd /workspace, native config loader).
const t0 = performance.now()
const vite = await import('vite')
const t1 = performance.now()
let config
try {
  config = await vite.resolveConfig({ root: '/workspace', configLoader: 'native', logLevel: 'info' }, 'serve', 'development')
} catch (e) {
  console.log(JSON.stringify({ importMs: +(t1 - t0).toFixed(1), failedAfterMs: +(performance.now() - t1).toFixed(1) }))
  throw e
}
const t2 = performance.now()
console.log(JSON.stringify({
  version: vite.version, importMs: +(t1 - t0).toFixed(1), resolveConfigMs: +(t2 - t1).toFixed(1),
  root: config.root, base: config.base, mode: config.mode, configFile: config.configFile, cacheDir: config.cacheDir,
  plugins: config.plugins.map((p) => p.name),
}, null, 1))
