import whole, { named, fn, pkg, self } from './cjs-lib.cjs';
import * as ns from './cjs-lib.cjs';
import data from './data.json' with { type: 'json' };
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);   // ESM declaring its own `require`
const __dirname = import.meta.dirname;            // ...and its own __dirname
export const result = {
  named, defaultIsModuleExports: whole === require('./cjs-lib.cjs'), defaultProperty: whole.default,
  unboundThis: fn() === undefined, nsKeys: Object.keys(ns).sort(), pkgName: pkg.name, dataList: data.list,
  jsonProto: Object.getPrototypeOf(data) === Object.prototype, self, dirnameOk: __dirname.endsWith('fixtures'),
  typeofModule: typeof module, typeofExports: typeof exports,
};
export { whole };
