import {writeFileSync} from 'node:fs'
import {resolve} from 'node:path'

// Bundle the verifier and execute body; never edit old retained recipes/receipts.
const output = process.argv[2]
if (!output) throw new Error('Usage: bun tests/prepare-reset-verifier.ts <fresh-output.js>')
const result = await Bun.build({entrypoints: [resolve(import.meta.dir, 'reset-verifier.js')], target: 'browser', format: 'cjs'})
if (!result.success) throw new Error(String(result.logs))
const helper = await result.outputs[0]!.text()
const body = await Bun.file(resolve(import.meta.dir, 'reset-evidence-v2.js')).text()
writeFileSync(output, `const ResetVerifier=(()=>{const module={exports:{}};const exports=module.exports;\n${helper}\nreturn module.exports})()\n${body}`, {flag: 'wx'})
