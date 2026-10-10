'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.named = 'named';
exports.default = 'cjs-default-property';
exports.fn = function () { return this; };
exports.pkg = require('./data.json');
exports.self = { thisIsExports: this === module.exports, newTarget: new.target === undefined };
exports.late = async () => (await import('./cycle-a.mjs')).counter;
