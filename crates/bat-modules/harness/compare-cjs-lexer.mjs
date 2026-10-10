// True-up of the CommonJS facts against the lexer Node itself uses to find
// named exports for `import { x } from "cjs"`.
//
//   node --expose-internals compare-cjs-lexer.mjs DIR [--verbose]
//
// Every CommonJS file under DIR is run through Node's internal lexer and
// through the transform; names or re-exports Node detects that the facts lack
// are failures (an import that works in Node would break). Extra names in the
// facts are reported but allowed.

import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTransform } from "../js/transform.ts";

const require = createRequire(import.meta.url);
const { internalBinding } = require("internal/test/binding");
const lexer = internalBinding("cjs_lexer");
const here = dirname(fileURLToPath(import.meta.url));
const transform = await createTransform(readFileSync(join(here, "../js/bat_modules.wasm")));
const root = process.argv[2];
const verbose = process.argv.includes("--verbose");

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile() && /\.(c?js)$/.test(entry.name)) yield path;
  }
}

let files = 0, exact = 0, superset = 0, missing = 0, lexerFailed = 0;
for (const path of walk(root)) {
  const source = readFileSync(path, "utf8");
  if (source.length > 4e6) continue;
  const out = transform(source, path, { forceKind: "cjs" });
  if (!out.ok) continue; // ESM syntax in a .js file: not CommonJS
  let names, reexports;
  try {
    [names, reexports] = lexer.parse(source);
  } catch {
    lexerFailed++;
    continue;
  }
  files++;
  const mine = new Set(out.facts.exports);
  const mineRe = new Set(out.facts.reexports);
  const lostNames = [...names].filter((n) => !mine.has(n));
  const lostRe = reexports.filter((r) => !mineRe.has(r));
  const extra = out.facts.exports.filter((n) => !names.has(n)).length + out.facts.reexports.filter((r) => !reexports.includes(r)).length;
  if (lostNames.length || lostRe.length) {
    missing++;
    if (missing <= 25 || verbose) console.log(`MISSING ${path}\n   names: ${lostNames.slice(0, 12).join(", ")}   reexports: ${lostRe.join(", ")}`);
  } else if (extra) {
    superset++;
    if (verbose) console.log(`extra   ${path}`);
  } else exact++;
}
console.log(`${files} CommonJS files: ${exact} identical to Node's lexer, ${superset} with extra names only, ${missing} missing something Node detects (${lexerFailed} the lexer rejected)`);
process.exit(missing ? 1 : 0);
