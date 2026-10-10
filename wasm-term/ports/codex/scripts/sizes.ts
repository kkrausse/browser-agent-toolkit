// Where a module's bytes are: section sizes, and code size per crate (from the
// name section, so run it on a build that kept its names: dist/codex.wasm).
//   bun scripts/sizes.ts [path.wasm] [--top N]
import { join } from "node:path";

const argv = process.argv.slice(2);
let top = 45;
let path = join(import.meta.dir, "../dist/codex.wasm");
while (argv.length) {
  const arg = argv.shift()!;
  if (arg === "--top") top = Number(argv.shift());
  else path = arg;
}
const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
let at = 8;
function leb(): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[at++]!;
    result += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return result;
    shift += 7;
  }
}
const text = new TextDecoder();
const SECTIONS = ["custom", "type", "import", "function", "table", "memory", "global", "export", "start", "element", "code", "data", "datacount"];
const sections: [string, number][] = [];
let imports = 0;
const bodies: number[] = [];
const names = new Map<number, string>();
while (at < bytes.length) {
  const id = bytes[at++]!;
  const size = leb();
  const end = at + size;
  let label = SECTIONS[id] ?? `section ${id}`;
  if (id === 0) {
    const length = leb();
    const name = text.decode(bytes.subarray(at, at + length));
    at += length;
    label = `custom:${name}`;
    if (name === "name") {
      while (at < end) {
        const kind = bytes[at++]!;
        const subEnd = leb() + at;
        if (kind === 1) {
          for (let count = leb(); count > 0; count--) {
            const index = leb();
            const nameLength = leb();
            names.set(index, text.decode(bytes.subarray(at, at + nameLength)));
            at += nameLength;
          }
        }
        at = subEnd;
      }
    }
  } else if (id === 2) {
    for (let count = leb(); count > 0; count--) {
      at += leb(); // module
      at += leb(); // field
      const kind = bytes[at++]!;
      if (kind === 0) { leb(); imports++; }
      else if (kind === 1) { at++; const flags = leb(); leb(); if (flags & 1) leb(); }
      else if (kind === 2) { const flags = leb(); leb(); if (flags & 1) leb(); }
      else if (kind === 3) at += 2;
    }
  } else if (id === 10) {
    for (let count = leb(); count > 0; count--) {
      const bodySize = leb();
      bodies.push(bodySize);
      at += bodySize;
    }
  }
  sections.push([label, size]);
  at = end;
}
const mb = (n: number) => `${(n / 1e6).toFixed(2).padStart(8)} MB`;
console.log(`${path}: ${mb(bytes.length)}`);
for (const [label, size] of sections.sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`${mb(size)}  ${label}`);
if (!names.size) process.exit(0);

/** The crate a function's code belongs to. A v0-mangled generic instance ends
 * with the crate that instantiated it, which is the one whose use put it in
 * the module; for anything else the last crate root in the name is its own. */
function crateOf(name: string): string {
  if (name.startsWith("_R")) {
    const roots = [...name.matchAll(/Cs[0-9A-Za-z]+_(\d+)/g)];
    const match = roots[roots.length - 1];
    if (!match) return "(rust, other)";
    const start = match.index + match[0].length;
    return name.slice(start, start + Number(match[1])).replace(/\.llvm$/, "");
  }
  if (name.startsWith("_ZN")) return "(legacy-mangled)";
  return "(C and unmangled)";
}
const perCrate = new Map<string, { size: number; count: number }>();
bodies.forEach((size, index) => {
  const crate = crateOf(names.get(imports + index) ?? "");
  const entry = perCrate.get(crate) ?? { size: 0, count: 0 };
  entry.size += size;
  entry.count++;
  perCrate.set(crate, entry);
});
console.log(`\ncode by crate (${bodies.length} functions):`);
for (const [crate, entry] of [...perCrate].sort((a, b) => b[1].size - a[1].size).slice(0, top)) {
  console.log(`${mb(entry.size)}  ${String(entry.count).padStart(7)}  ${crate}`);
}
