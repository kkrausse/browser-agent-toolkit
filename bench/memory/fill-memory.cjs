// Guest for the exhaustion check: write a file in 4 MiB pieces until the kernel refuses,
// then show that the runtime still works (the file is removed, a small one is written and
// read back, an image file is read). Expected with `?kmem=1024` (64 MiB): ENOSPC after
// roughly 40 MiB, then "STILL-WORKS". Run through the harness:
//   bun runtime/harness/cli.ts run --query 'kmem=1024' bench/memory/fill-memory.cjs
const fs = require('node:fs')
const piece = Buffer.alloc(4 << 20, 7)
let written = 0, error
const fd = fs.openSync('/tmp/fill.bin', 'w')
try {
  for (let i = 0; i < 200; i++) { fs.writeSync(fd, piece); written += piece.length }
} catch (e) { error = e }
fs.closeSync(fd)
console.log(`FILL wrote ${written >> 20} MiB, then: ${error ? `${error.code}: ${error.message}` : 'no error'}`)
fs.unlinkSync('/tmp/fill.bin')
fs.writeFileSync('/tmp/small.txt', 'ok')
const pkg = JSON.parse(fs.readFileSync('/workspace/node_modules/vite/package.json', 'utf8'))
console.log(`STILL-WORKS ${fs.readFileSync('/tmp/small.txt', 'utf8')} vite ${pkg.version}`)
