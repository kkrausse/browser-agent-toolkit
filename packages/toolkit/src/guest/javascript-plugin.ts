import type { Plugin } from '@opencode/plugin/effect';
import { Effect } from 'effect';
import { runJavascript, type JavascriptInput } from './javascript-runner';

export const JAVASCRIPT_INSTRUCTIONS = `This is a browser-local JavaScript environment, not native Node, Bun, or an OS shell.
Use runJavascript for execution. Each call runs a fresh JavaScript ES module with top-level await, installed-package imports, and supported node:* APIs. Files persist; JS variables do not. BROWSER_AGENT_GUEST=1 is automatic. Use console.log/error for results; a top-level return is not allowed.
The shell tool is unavailable. Read package.json to understand verification steps, but package scripts may use unsupported native binaries, Bun flags, or Bun APIs. Prefer a package's JS/WASM API or launch its installed JS entrypoint with child_process.spawn and an argument array. Do not assume all Node/Bun APIs work. Report the actual runtime error when an API is missing. External package installation is not assumed available.
Examples for runJavascript code:
  import { readFileSync } from 'node:fs'; console.log(JSON.parse(readFileSync('package.json', 'utf8')).scripts);
  import { spawn } from 'node:child_process'; const p = spawn(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], { stdio: ['ignore', 'pipe', 'pipe'] }); p.stdout.on('data', b => process.stdout.write(b)); p.stderr.on('data', b => process.stderr.write(b)); await new Promise((resolve, reject) => { p.on('error', reject); p.on('close', code => { process.exitCode = code ?? 1; resolve(); }); });
For WASM-backed packages, inspect their exports/docs, then import the supported JS API and await any required initialization. There is no universal WASM CLI API. TypeScript's tsc alone does not replace framework type generation: preserve all relevant package-script steps.
Results include status, stdout, stderr, exitCode, signal, elapsed time, diagnostics, and paths to complete output logs. A non-completed status means verification did not succeed. Inline output may be truncated; use read on the provided log paths for the rest.`;

export default {
  id: 'editor.javascript',
  effect: ctx => Effect.gen(function* () {
    yield* ctx.tool.transform(editor => {
      editor.remove('shell');
      editor.add({
        name: 'runJavascript',
        description: JAVASCRIPT_INSTRUCTIONS,
        input: { type: 'object', properties: {
          code: { type: 'string', minLength: 1, description: 'JavaScript ES module source. Top-level await and imports supported; log results with console.log.' },
          cwd: { type: 'string', description: 'Absolute guest working directory; defaults to /workspace. Relative imports resolve from here.' },
          timeoutMs: { type: 'integer', minimum: 1, maximum: 300000, description: 'Execution timeout in milliseconds; default 60000.' },
        }, required: ['code'], additionalProperties: false },
        options: { permission: 'runJavascript', codemode: false },
        execute: (input, tool) => Effect.gen(function* () {
          yield* tool.progress({ title: 'Run guest JavaScript', status: 'starting' });
          const result = yield* Effect.promise(signal => runJavascript(input as JavascriptInput, {
            signal,
            progress: progress => {
              // Progress is best effort; final content also includes diagnostics and full log paths.
              Effect.runFork(tool.progress({ title: 'Run guest JavaScript', ...progress }));
            },
          }));
          return { content: JSON.stringify(result, null, 2), metadata: { title: 'Run guest JavaScript', ...result } };
        }),
      });
    });
    yield* ctx.session.hook('context', event => Effect.sync(() => {
      event.system.push({ type: 'text', text: JAVASCRIPT_INSTRUCTIONS });
    }));
  }),
} satisfies Plugin.Plugin;
