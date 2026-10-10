import { readFile } from 'node:fs/promises';
const text = await readFile(new URL(import.meta.url), 'utf8');
export const length = text.length;
export const meta = { filename: import.meta.filename, dirname: import.meta.dirname, resolved: import.meta.resolve('./cjs-lib.cjs') };
for await (const x of (async function* () { yield 1; })()) { globalThis.__tlaSaw = x; }
