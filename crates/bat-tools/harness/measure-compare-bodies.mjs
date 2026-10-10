// measure-compare-bodies.mjs <crawl out dir A> <crawl out dir B>
// Compares the bodies two vite-crawl.mjs runs saved, after replacing what differs between
// any two runs of the same tree: the dependency optimizer's per-start browser hash
// (?v=xxxxxxxx in URLs, hence in file names and in import specifiers), ?t= timestamps,
// Vite's WebSocket token, React Router's random dev manifest version, and the base64 inline
// source maps that repeat any of those.
// Prints the files whose normalised bodies differ; exit status 1 if any.
import fs from 'node:fs';
import path from 'node:path';

const [a, b] = process.argv.slice(2);
const skip = new Set(['requests.json', 'summary.json', 'vite.log', 'esbuild-trace.jsonl']);
const plain = text => text
  .replace(/([?&_]v[=_])[0-9a-f]{8}/g, '$1HASH').replace(/([?&_]t[=_])\d{10,}/g, '$1TIME')
  .replace(/(const wsToken = \\?")[\w-]{12}/g, '$1TOKEN')                       // Vite's per-start WebSocket token
  .replace(/('version\\?':\\?')0\.\d+/g, '$1RANDOM');                            // React Router dev manifest version: Math.random()
// Inline source maps repeat the module text in base64; compare them decoded.
const normalise = text => plain(text.replace(/base64,([A-Za-z0-9+/=]{40,})/g, (_, data) => `base64-decoded,${plain(Buffer.from(data, 'base64').toString())}`));
// Two modules carry a random value in their text (Vite's client: the token; React Router's
// manifest: the version), so their source map mappings shift with its length and its
// characters. Their mappings are left out; every other module's are compared.
const randomText = /_vite__client$|virtual_react-router__browser-manifest$/;
const withoutMappings = text => text.replace(/"mappings":"[^"]*"/g, '"mappings":"..."');
const read = dir => new Map(fs.readdirSync(dir).filter(name => !skip.has(name)).map(name => [normalise(name), { name, body: fs.readFileSync(path.join(dir, name), 'utf8') }]));
const left = read(a), right = read(b);
let different = 0, identical = 0, afterNormalising = 0;
for (const [key, { body }] of left) {
  const other = right.get(key);
  if (!other) { different++; console.log(`only in A: ${key}`); continue; }
  if (body === other.body) identical++;
  else if (normalise(body) === normalise(other.body) || (randomText.test(key) && withoutMappings(normalise(body)) === withoutMappings(normalise(other.body)))) afterNormalising++;
  else { different++; console.log(`differs: ${key} (${body.length} vs ${other.body.length} chars)`); }
}
for (const key of right.keys()) if (!left.has(key)) { different++; console.log(`only in B: ${key}`); }
console.log(`${left.size} bodies in A, ${right.size} in B: ${identical} byte-identical, ${afterNormalising} identical after replacing per-start values, ${different} different`);
process.exit(different ? 1 : 0);
