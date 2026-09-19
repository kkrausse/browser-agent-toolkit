// Bundled by scripts/test-javascript.ts, executed inside real Vivari process workers.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { Effect } from 'effect';
import plugin from '../src/javascript-plugin';
import { runJavascript, type JavascriptResult } from '../src/javascript-runner';
import type { Plugin } from '@opencode/plugin/effect';

function check(condition: unknown, detail: unknown): asserts condition {
  if (!condition) throw Error(JSON.stringify(detail));
}
let execute!: (input: { code: string; timeoutMs?: number }, tool: { progress: (data: unknown) => Effect.Effect<void> }) => Effect.Effect<{ content: string }>;
const removed: string[] = [];
const ctx = {
  tool: { transform: (fn: (editor: unknown) => void) => Effect.sync(() => fn({
    remove: (name: string) => removed.push(name), add: (tool: { execute: typeof execute }) => { execute = tool.execute; },
  })) },
  session: { hook: () => Effect.void },
} as unknown as Plugin.Context;
await Effect.runPromise(Effect.scoped(plugin.effect(ctx)));
check(removed.includes('shell'), removed);
const progress: unknown[] = [];
const tool = { progress: (value: unknown) => Effect.sync(() => { progress.push(value); }) };
const run = async (code: string, timeoutMs?: number): Promise<JavascriptResult> => {
  const result = await Effect.runPromise(execute({ code, timeoutMs }, tool));
  const parsed = JSON.parse(result.content);
  console.log('CASE', JSON.stringify(parsed));
  return parsed;
};
const imports = await run(`import { value } from './helper.mjs'; import { readFileSync } from 'node:fs'; console.log(value, process.env.BROWSER_AGENT_GUEST, JSON.parse(readFileSync('package.json', 'utf8')).name);`);
check(imports.status === 'completed' && imports.stdout === '42 1 guest-fixture\n', imports);
const wasm = await run(`import { add } from 'probe-wasm'; console.log(await add(20, 22));`);
check(wasm.status === 'completed' && wasm.stdout === '42\n', wasm);
const ts = await run(`import ts from 'typescript'; console.log(ts.transpileModule('const answer: number = 42;', { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText);`);
check(ts.status === 'completed' && ts.stdout.includes('const answer = 42'), ts);
const cli = `import { spawn } from 'node:child_process'; const p = spawn('/bin/node.js', ['node_modules/typescript/bin/tsc', '--noEmit', '--lib', 'es5', 'check.ts'], { stdio: ['ignore', 'pipe', 'pipe'] }); p.stdout.on('data', b => process.stdout.write(b)); p.stderr.on('data', b => process.stderr.write(b)); await new Promise((resolve, reject) => { p.on('error', reject); p.on('close', code => { process.exitCode = code ?? 1; resolve(); }); });`;
const passed = await run(cli);
check(passed.status === 'completed' && passed.exitCode === 0, passed);
writeFileSync('/workspace/check.ts', 'const answer: number = "wrong";');
const failed = await run(cli);
check(failed.status === 'failed' && failed.stdout.includes('TS2322'), failed);
const error = await run('console.log("before"); throw Error("visible guest error");');
check(error.status === 'failed' && error.stderr.includes('visible guest error') && error.stdout === 'before\n', error);
const syntax = await run('import {');
check(syntax.status === 'failed' && syntax.stderr.length > 0, syntax);
const missing = await run('Bun.YAML.parse("hello: world");');
check(missing.status === 'failed' && missing.stderr.includes('Bun'), missing);
const output = await run('console.log("x".repeat(40000));');
check(output.status === 'completed' && output.output.truncated && readFileSync(output.output.stdoutFile).length === 40001, output.output);
const timed = await run('console.log("waiting"); setInterval(() => {}, 1000);', 500);
check(timed.status === 'timeout' && timed.signal === 'SIGKILL' && timed.stdout === 'waiting\n', timed);
const abort = new AbortController();
const task = runJavascript({ code: 'setInterval(() => {}, 1000);' }, { signal: abort.signal });
setTimeout(() => abort.abort('guest test cancellation'), 500);
const cancelled = await task;
check(cancelled.status === 'cancelled' && cancelled.signal === 'SIGKILL', cancelled);
const interrupt = new AbortController();
const interrupted = Effect.runPromise(execute({ code: 'setInterval(() => {}, 1000);' }, tool), { signal: interrupt.signal }).catch(() => 'interrupted');
setTimeout(() => interrupt.abort(), 500);
check(await interrupted === 'interrupted', 'Effect execution must interrupt');
// Wait for the guest child's close/cleanup after Effect aborts the Promise executor.
await new Promise(resolve => setTimeout(resolve, 200));
check(!readdirSync('/workspace').some(name => name.startsWith('.runJavascript-')), 'Temporary source leaked');
check(progress.length > 0, 'No caller progress');
console.log('JAVASCRIPT_GUEST_PASS');
