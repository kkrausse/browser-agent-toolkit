import { expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Effect } from 'effect';
import plugin from '../src/javascript-plugin';
import { runJavascript, type JavascriptResult } from '../src/javascript-runner';
import type { Plugin } from '@opencode/plugin/effect';

async function fixture(run: (cwd: string, execute: (code: string, options?: { timeoutMs?: number; signal?: AbortSignal; executable?: string }) => Promise<JavascriptResult>) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'guest-javascript-'));
  try {
    await run(cwd, (code, options = {}) => runJavascript({ code, cwd, timeoutMs: options.timeoutMs }, {
      signal: options.signal ?? new AbortController().signal,
      executable: options.executable ?? process.execPath,
      logDirectory: join(cwd, 'logs'),
    }));
    expect((await readdir(cwd)).some(name => name.startsWith('.runJavascript-'))).toBe(false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

test('fresh modules support relative imports, await, guest env and persistent files', async () => {
  await fixture(async (cwd, execute) => {
    await writeFile(join(cwd, 'helper.mjs'), 'export const value = 42');
    const result = await execute(`import { value } from './helper.mjs'; import { writeFile } from 'node:fs/promises'; await writeFile('saved.txt', String(value)); console.log(value, process.env.BROWSER_AGENT_GUEST); console.error('diagnostic'); globalThis.leak = true;`);
    expect(result).toMatchObject({ status: 'completed', exitCode: 0, stdout: '42 1\n', stderr: 'diagnostic\n', output: { truncated: false } });
    expect(await readFile(join(cwd, 'saved.txt'), 'utf8')).toBe('42');
    expect((await execute('console.log(globalThis.leak)')).stdout).toBe('undefined\n');
  });
});

test('nonzero exits, syntax and missing APIs preserve stderr and stack traces', async () => {
  await fixture(async (_cwd, execute) => {
    const nonzero = await execute('console.log("before"); process.exitCode = 7;');
    expect(nonzero).toMatchObject({ status: 'failed', exitCode: 7, stdout: 'before\n' });
    const syntax = await execute('import {');
    expect(syntax.status).toBe('failed'); expect(syntax.stderr).not.toBe('');
    const error = await execute('console.log("before"); throw new Error("missing guest capability");');
    expect(error.stderr).toContain('missing guest capability'); expect(error.stdout).toBe('before\n');
  });
});

test('bounded inline output retains full bytes in caller-visible log files', async () => {
  await fixture(async (_cwd, execute) => {
    const result = await execute('process.stdout.write("x".repeat(80000)); process.stderr.write("λ".repeat(20000));');
    expect(result.status).toBe('completed');
    expect(result.output).toMatchObject({ stdoutBytes: 80000, stderrBytes: 40000, truncated: true });
    expect(result.stdout.length).toBe(32768);
    expect((await readFile(result.output.stdoutFile)).length).toBe(80000);
    expect((await readFile(result.output.stderrFile)).length).toBe(40000);
    expect(result.diagnostics.at(-1)?.event).toBe('output-truncated');
  });
});

test('timeout and cancellation kill execution and retain partial output', async () => {
  await fixture(async (_cwd, execute) => {
    const timeout = await execute('console.log("started"); setInterval(() => {}, 1000);', { timeoutMs: 300 });
    expect(timeout.status).toBe('timeout'); expect(timeout.stdout).toBe('started\n');
    expect(timeout.signal).toBe('SIGKILL');
    const controller = new AbortController();
    const task = execute('console.log("started"); setInterval(() => {}, 1000);', { signal: controller.signal });
    const timer = setTimeout(() => controller.abort('test cancellation'), 300);
    const cancelled = await task; clearTimeout(timer);
    expect(cancelled.status).toBe('cancelled'); expect(cancelled.signal).toBe('SIGKILL');
    expect(cancelled.diagnostics.some(item => item.detail.includes('test cancellation'))).toBe(true);
  });
});

test('launch failures and pre-cancellation are explicit results', async () => {
  await fixture(async (_cwd, execute) => {
    const result = await execute('console.log("never")', { executable: '/missing/guest-executable' });
    expect(result.status).toBe('launch-error'); expect(result.exitCode).toBeNull();
    expect(result.diagnostics.some(item => /ENOENT|not found/.test(item.detail))).toBe(true);
    const cancelled = await execute('throw Error("never")', { signal: AbortSignal.abort('already cancelled') });
    expect(cancelled.status).toBe('cancelled'); expect(cancelled.stdout).toBe('');
  });
});

test('plugin removes shell, registers direct JS execution, and teaches limitations', async () => {
  const removed: string[] = [], tools: { name: string; description: string; options?: { permission?: string; codemode?: boolean } }[] = [];
  const event = { system: [] as { type: string; text: string }[] };
  const ctx = {
    tool: { transform: (fn: (editor: unknown) => void) => Effect.sync(() => fn({ remove: (name: string) => removed.push(name), add: (tool: typeof tools[number]) => tools.push(tool) })) },
    session: { hook: (_name: string, fn: (event: unknown) => Effect.Effect<void>) => fn(event) },
  } as unknown as Plugin.Context;
  await Effect.runPromise(Effect.scoped(plugin.effect(ctx)));
  expect(removed).toEqual(['shell']);
  expect(tools[0]).toMatchObject({ name: 'runJavascript', options: { permission: 'runJavascript', codemode: false } });
  expect(event.system[0]?.text).toContain('not native Node, Bun');
  expect(tools[0]?.description).toContain('does not replace framework type generation');
});
