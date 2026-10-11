// @babel/core transforming JSX and TSX the way the TODO example's @vitejs/plugin-react does (resolved from
// that package, which depends on it, as Bun's isolated layout requires).
const path = require('path')
const { createRequire } = require('module')
const t0 = performance.now()
const rr = createRequire(require.resolve('@vitejs/plugin-react'))
const babel = rr('@babel/core')
const t1 = performance.now()
const out = babel.transformSync('const App = () => <div className="x">{items.map(i => <Item key={i} {...i} />)}</div>', {
  babelrc: false, configFile: false, filename: '/workspace/src/x.jsx',
  parserOpts: { plugins: ['jsx'] },
  plugins: [[rr.resolve('@babel/plugin-transform-react-jsx-self')], [rr.resolve('@babel/plugin-transform-react-jsx-source')]],
  presets: [],
})
const t2 = performance.now()
let jsx
try {
  jsx = babel.transformSync('export default (props: { n: number }) => <b>hi {props.n as number}</b>', { babelrc: false, configFile: false, filename: '/workspace/src/y.tsx', parserOpts: { plugins: ['jsx', 'typescript'] } }).code
} catch (e) { jsx = 'tsx: ' + e.message.split('\n')[0] }
console.log(JSON.stringify({ version: babel.version, requireMs: +(t1 - t0).toFixed(1), transformMs: +(t2 - t1).toFixed(1) }))
console.log(out.code)
console.log(jsx)
