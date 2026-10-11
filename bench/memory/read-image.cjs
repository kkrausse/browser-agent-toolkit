// Guest for the image-cache measurements: read files of the dependency image until `MB`
// megabytes have been read, `PASSES` times over the same files, and print the time of each
// pass. With a cache limit below MB the later passes read every chunk from the stored image
// again; without one they are served from memory. Run through the harness:
//   bun runtime/harness/cli.ts run --query 'cache=16777216' --env MB=96 bench/memory/read-image.cjs
const fs = require('node:fs')
const path = require('node:path')
const want = Number(process.env.MB || 96) * 1048576
const passes = Number(process.env.PASSES || 3)
const files = []
let total = 0
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (total >= want) return
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.isFile()) {
      const size = fs.statSync(full).size
      if (size < 4096) continue
      files.push(full)
      total += size
    }
  }
}
walk(process.env.ROOT || '/workspace/node_modules')
const out = { files: files.length, mb: Math.round(total / 104857.6) / 10, passMs: [] }
for (let pass = 0; pass < passes; pass++) {
  const t = performance.now()
  let bytes = 0
  for (const file of files) bytes += fs.readFileSync(file).length
  out.passMs.push(Math.round((performance.now() - t) * 10) / 10)
  if (bytes !== total) throw Error(`read ${bytes} of ${total}`)
}
console.log('READ-IMAGE ' + JSON.stringify(out))
