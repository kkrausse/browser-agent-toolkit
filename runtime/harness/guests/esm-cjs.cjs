exports.value = 'cjs'
// require(esm): synchronous graph, no top-level await
exports.fromEsm = require('./esm-helper.mjs').fromHelper()
