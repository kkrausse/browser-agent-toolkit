// react-dom/server rendering an element (sync and streaming).
import { createElement as h, useState, Suspense } from 'react'
import { renderToString, renderToPipeableStream } from 'react-dom/server'
import { Writable } from 'node:stream'
const t0 = performance.now()
function Counter({ start }) {
  const [n] = useState(start)
  return h('button', { className: 'c', 'data-n': n }, 'count ', n)
}
const html = renderToString(h('main', null, h('h1', null, 'Todos'), h(Counter, { start: 3 })))
console.log(html)
let streamed = ''
const sink = new Writable({ write(chunk, _e, cb) { streamed += chunk; cb() } })
await new Promise((resolve, reject) => {
  const s = renderToPipeableStream(h(Suspense, { fallback: 'loading' }, h(Counter, { start: 7 })), {
    onAllReady() { s.pipe(sink) }, onError: reject,
  })
  sink.on('finish', resolve)
})
console.log(streamed)
console.log('ms', (performance.now() - t0).toFixed(1), 'env', process.env.NODE_ENV)
