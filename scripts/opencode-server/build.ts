#!/usr/bin/env bun
// Builds the OpenCode server artefact the runtime runs, from the published packages pinned
// in `bun.lock` here: one Node-target ESM file and the three tree-sitter grammars.
//
//   bun install --frozen-lockfile --linker isolated && bun build.ts [out directory]
//
// Default output: `<repository>/.runtime/opencode-<version>/`, with an `application.json`
// (`{ id, files: { <name>: { bytes, sha256 } } }`) that `bat-prepare` takes in place of its
// policy's pins when it is given this directory (`--opencode`, `BAT_OPENCODE_DIR`,
// `prepare({ openCodeDir })`). The bundle's bytes depend on the Bun version and on this
// directory's path, so what pins this artefact is `bun.lock` (the published archives'
// integrity), not a hash of the output.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const here = import.meta.dirname
const lock = Bun.JSONC.parse(await Bun.file(join(here, 'bun.lock')).text()) as { packages: Record<string, unknown[]> }
const version = String(lock.packages['@opencode/server']?.[0]).replace('@opencode/server@', '')
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('bun.lock names no @opencode/server version')
const out = resolve(process.argv[2] ?? join(here, `../../.runtime/opencode-${version}`))
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const result = await Bun.build({
  entrypoints: [join(here, 'server.ts')],
  target: 'node', format: 'esm', outdir: out,
  define: { OPENCODE_SERVER_VERSION: JSON.stringify(version) },
  plugins: [{
    // Its UMD entry requires `./impl/format` in a way a bundle cannot resolve.
    name: 'jsonc-parser-esm',
    setup(build) {
      build.onResolve({ filter: /^jsonc-parser$/ }, args => ({ path: resolve(dirname(createRequire(args.importer).resolve('jsonc-parser')), '../esm/main.js') }))
    },
  }],
})
if (!result.success) throw new AggregateError(result.logs, 'OpenCode server build failed')

const requireCore = createRequire(createRequire(import.meta.resolve('@opencode/server/process')).resolve('@opencode/core/package.json'))
for (const [pkg, file] of [['web-tree-sitter', 'tree-sitter.wasm'], ['tree-sitter-bash', 'tree-sitter-bash.wasm'], ['tree-sitter-powershell', 'tree-sitter-powershell.wasm']] as const) {
  await Bun.write(join(out, file), Bun.file(requireCore.resolve(`${pkg}/${file}`)))
}
const files = Object.fromEntries(result.outputs.map(output => output.path.slice(out.length + 1)).concat(['tree-sitter.wasm', 'tree-sitter-bash.wasm', 'tree-sitter-powershell.wasm']).sort().map(name => {
  const bytes = readFileSync(join(out, name))
  return [name, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }]
}))
// What `bat-prepare` reads from the directory in place of its policy's pins.
const grammars = ['server.js', 'tree-sitter.wasm', 'tree-sitter-bash.wasm', 'tree-sitter-powershell.wasm']
await Bun.write(join(out, 'application.json'), JSON.stringify({ id: `opencode-server-process-${version}`, files: Object.fromEntries(grammars.map(name => [name, files[name]])) }, null, 2) + '\n')
console.log(JSON.stringify({ version, out, bun: Bun.version, files }, null, 2))
