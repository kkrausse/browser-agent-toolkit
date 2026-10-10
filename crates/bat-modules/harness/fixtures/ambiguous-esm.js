// No package.json "type" here and no import/export: only the lexical
// redeclaration of `require` makes this an ES module, as in Node.
const require = 1;
globalThis.__ambiguousThis = this;
