// measure-trace-summary.mjs <trace.jsonl>... [--json]
//
// Summarises BAT_MEASURE_TRACE files written by the wrappers measure-install.mjs installs.
// With several files (one per run) every number is "median (min-max)" across the runs.
// A call counts as top-level when no other recorded call's [start, end] interval contains
// it; nested calls (the binding parse inside parseAst, parser/traverse/generator inside
// @babel/core transformAsync) are listed but left out of the "top-level ms" totals.
import fs from 'node:fs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const files = args.filter(a => a !== '--json');
const read = file => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const stat = values => {
  const sorted = values.filter(v => v !== undefined).sort((a, b) => a - b);
  if (!sorted.length) return '-';
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const fmt = n => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  return sorted.length === 1 || sorted[0] === sorted.at(-1) ? fmt(median) : `${fmt(median)} (${fmt(sorted[0])}-${fmt(sorted.at(-1))})`;
};
const sum = values => values.reduce((a, b) => a + b, 0);

const summarise = file => {
  const records = read(file).filter(r => r.pkg !== 'hook');
  const pids = new Set(records.map(r => r.pid));
  const calls = records.filter(r => r.api !== 'load').map(r => ({ ...r, start: r.at - r.ms, end: r.at }));
  for (const call of calls)
    call.top = !calls.some(other => other !== call && other.pid === call.pid && other.start <= call.start && other.end >= call.end && (other.start < call.start || other.end > call.end || other.depth < call.depth));
  const groups = {};
  for (const call of calls) {
    const key = `${call.pkg} ${call.api}`;
    const group = (groups[key] ??= { calls: 0, ms: 0, topCalls: 0, topMs: 0, inBytes: 0, first: undefined, maxMs: 0, restMs: 0 });
    group.calls++; group.ms += call.ms; group.inBytes += call.inBytes ?? 0; group.maxMs = Math.max(group.maxMs, call.ms);
    if (group.first === undefined) group.first = call.ms; else group.restMs += call.ms;
    if (call.top) { group.topCalls++; group.topMs += call.ms; }
  }
  const loads = {};
  for (const r of records.filter(r => r.api === 'load')) loads[r.pkg] = { ms: r.ms, at: r.at, rssDeltaMb: r.rssDeltaMb, caller: r.caller };
  const callers = {};
  for (const call of calls.filter(c => c.top && c.caller)) {
    const key = `${call.pkg} ${call.api} <- ${call.caller.split(' < ')[0].replace(/:\d+:\d+\)?$/, '').replace(/^.*\(/, '').replace(/@[^:]*:/, ':')} ${call.caller.split(' ')[0]}`;
    const entry = (callers[key] ??= { calls: 0, ms: 0, inBytes: 0 });
    entry.calls++; entry.ms += call.ms; entry.inBytes += call.inBytes ?? 0;
  }
  const families = { rollup: /^rollup/, babel: /babel/, lightningcss: /^lightningcss/ };
  const familyTop = Object.fromEntries(Object.entries(families).map(([name, re]) => [name, sum(calls.filter(c => c.top && re.test(c.pkg)).map(c => c.ms))]));
  return { file, pids: pids.size, groups, loads, callers, familyTop, calls };
};

const runs = files.map(summarise);
if (json) { console.log(JSON.stringify(runs.map(({ calls, ...rest }) => rest), null, 1)); process.exit(0); }
const keys = pick => [...new Set(runs.flatMap(run => Object.keys(pick(run))))];
console.log(`runs: ${runs.length}; processes per run: ${stat(runs.map(r => r.pids))}\n`);
console.log('| package | load ms | first loaded at ms | rss delta MB | required from |\n|---|---|---|---|---|');
for (const key of keys(r => r.loads))
  console.log(`| ${key} | ${stat(runs.map(r => r.loads[key]?.ms))} | ${stat(runs.map(r => r.loads[key]?.at))} | ${stat(runs.map(r => r.loads[key]?.rssDeltaMb))} | ${(runs.find(r => r.loads[key])?.loads[key].caller ?? '').split(' < ')[0]} |`);
console.log('\n| call | calls | total ms | top-level calls | top-level ms | first call ms | later calls ms | max ms | input bytes |\n|---|---|---|---|---|---|---|---|---|');
for (const key of keys(r => r.groups)) {
  const of = field => stat(runs.map(r => r.groups[key]?.[field]));
  console.log(`| ${key} | ${of('calls')} | ${of('ms')} | ${of('topCalls')} | ${of('topMs')} | ${of('first')} | ${of('restMs')} | ${of('maxMs')} | ${of('inBytes')} |`);
}
console.log('\n| top-level ms by family | ms |\n|---|---|');
for (const key of keys(r => r.familyTop)) console.log(`| ${key} | ${stat(runs.map(r => r.familyTop[key]))} |`);
console.log('\n| top-level call <- caller | calls | ms | input bytes |\n|---|---|---|---|');
for (const key of keys(r => r.callers)) {
  const of = field => stat(runs.map(r => r.callers[key]?.[field]));
  console.log(`| ${key} | ${of('calls')} | ${of('ms')} | ${of('inBytes')} |`);
}
