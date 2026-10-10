// The page: one script, no framework.
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const outdir = resolve(import.meta.dirname, '.build')
rmSync(outdir, { recursive: true, force: true })
const result = await Bun.build({ entrypoints: [resolve(import.meta.dirname, 'src/main.ts')], outdir, target: 'browser', format: 'esm', sourcemap: 'linked' })
if (!result.success) throw new AggregateError(result.logs, 'Page build failed')
console.log(`Built ${result.outputs.map(output => output.path.slice(outdir.length + 1)).join(', ')}`)
