// Emit the benchmark workload description for a source tree: a sample of
// small files (for stat hits and reads), and the largest file.
import { readdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
const small: string[] = []
let largest = { path: '', size: 0 }
let files = 0
let bytes = 0
let symlinks = 0
const walk = (dir: string, rel: string) => {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name)
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isSymbolicLink()) symlinks++
    else if (e.isDirectory()) walk(p, r)
    else if (e.isFile()) {
      const size = lstatSync(p).size
      files++
      bytes += size
      if (size > largest.size) largest = { path: r, size }
      if (size > 0 && size <= 65536) small.push(r)
    }
  }
}
walk(root, '')
const sample = small.filter((_, i) => i % 3 === 0)
console.log(JSON.stringify({ files, bytes, symlinks, largest, sample }))
