// @babel/core transforming JSX (resolved from the package that depends on it, as Bun's isolated layout requires).
const path = require('path')
const { createRequire } = require('module')
const t0 = performance.now()
const rr = createRequire(require.resolve('@react-router/dev/package.json'))
const babel = rr('@babel/core')
const t1 = performance.now()
const out = babel.transformSync('const App = () => <div className="x">{items.map(i => <Item key={i} {...i} />)}</div>', {
  babelrc: false, configFile: false, filename: '/workspace/src/x.jsx',
  plugins: [[rr.resolve('@babel/plugin-syntax-jsx')]],
  presets: [],
})
const t2 = performance.now()
let jsx
try {
  jsx = babel.transformSync('export default () => <b>hi</b>', { babelrc: false, configFile: false, filename: '/workspace/src/y.tsx', presets: [[rr.resolve('@babel/preset-typescript'), { isTSX: true, allExtensions: true }]] }).code
} catch (e) { jsx = 'preset-typescript: ' + e.message.split('\n')[0] }
console.log(JSON.stringify({ version: babel.version, requireMs: +(t1 - t0).toFixed(1), transformMs: +(t2 - t1).toFixed(1) }))
console.log(out.code)
console.log(jsx)
