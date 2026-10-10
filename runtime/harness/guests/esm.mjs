// ES module with top-level await, JSON import, CommonJS interop, dynamic import, import.meta, cycles.
import fs, { readFileSync, promises as fsp } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'path'
import { setTimeout as sleep } from 'node:timers/promises'
import pkg from '/workspace/package.json' with { type: 'json' }
import React, { createElement, version } from 'react'
import * as helper from './esm-helper.mjs'
import { counter, bump } from './esm-helper.mjs'

const t0 = performance.now()
await sleep(10)
const waited = performance.now() - t0
const require = createRequire(import.meta.url)
const cjs = require('./esm-cjs.cjs')
const dyn = await import('./esm-helper.mjs')
bump()
console.log(JSON.stringify({
  waited: waited >= 9,
  url: import.meta.url,
  filename: import.meta.filename,
  dirname: import.meta.dirname,
  main: import.meta.main,
  resolve: import.meta.resolve('react'),
  pkg: pkg.name,
  react: [typeof React.createElement, createElement === React.createElement, version],
  liveBinding: [counter, helper.counter, dyn === helper],
  cjsDefault: cjs.value,
  cjsRequiresEsm: cjs.fromEsm,
  fsNamed: readFileSync === fs.readFileSync && typeof fsp.readFile === 'function',
  typeofRequire: typeof module,
  base: path.basename(import.meta.filename),
  cycle: helper.cycleValue(),
}, null, 1))
const text = await fsp.readFile(new URL('./esm-helper.mjs', import.meta.url), 'utf8')
console.log('read self sibling', text.length > 10)
try {
  await import('./does-not-exist.mjs')
} catch (e) {
  console.log('missing import:', e.code)
}
try {
  require('not-a-package')
} catch (e) {
  console.log('missing require:', e.code)
}
