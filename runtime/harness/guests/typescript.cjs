// require('typescript') from the image and compile a snippet.
const t0 = performance.now()
const ts = require('typescript')
const t1 = performance.now()
const out = ts.transpileModule('enum E { A, B }\nexport const f = (x: number): string => `${x}:${E[x]}`\n', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } })
const t2 = performance.now()
const program = ts.createProgram(['/workspace/.harness/ts-lib.ts'], { noEmit: true, noLib: true, skipLibCheck: true })
const diags = ts.getPreEmitDiagnostics(program).length
const t3 = performance.now()
console.log(JSON.stringify({ version: ts.version, requireMs: +(t1 - t0).toFixed(1), transpileMs: +(t2 - t1).toFixed(1), programMs: +(t3 - t2).toFixed(1), diags, first: performance.timeOrigin + t0 }))
console.log(out.outputText.trim())
