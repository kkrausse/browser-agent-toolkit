const withDefault = require('./cycle-a.mjs');
const star = require('./star.mjs');
let asyncError;
try { require('./tla-required.mjs'); } catch (error) { asyncError = error.code; }
module.exports = {
  esModuleFlag: withDefault.__esModule, defaultResult: withDefault.default(), counter: withDefault.counter,
  starIsNamespace: star[Symbol.toStringTag], starB: star.b, starNamed: star.named, starHasDefault: 'default' in star,
  asyncError,
};
