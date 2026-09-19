import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';

export type JavascriptInput = { code: string; cwd?: string; timeoutMs?: number };
export type JavascriptResult = {
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled' | 'launch-error';
  runtime: 'vivari'; cwd: string; durationMs: number; exitCode: number | null; signal: string | null;
  stdout: string; stderr: string;
  output: { stdoutBytes: number; stderrBytes: number; truncated: boolean; stdoutFile: string; stderrFile: string };
  diagnostics: { elapsedMs: number; event: string; detail: string }[];
};

/** Runs in the guest server. The submitted module always runs in a separate guest process. */
export async function runJavascript(input: JavascriptInput, options: {
  signal: AbortSignal;
  progress?: (result: JavascriptResult) => void;
  executable?: string;
  logDirectory?: string;
}): Promise<JavascriptResult> {
  const started = Date.now(), id = randomUUID();
  const cwd = normalize(input.cwd ?? '/workspace');
  const timeoutMs = input.timeoutMs ?? 60_000;
  const directory = join(options.logDirectory ?? '/workspace/.server/javascript', id);
  const entry = join(cwd, `.runJavascript-${id}.mjs`);
  const stdoutFile = join(directory, 'stdout.log'), stderrFile = join(directory, 'stderr.log');
  const limit = 32_768;
  const buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const result: JavascriptResult = {
    status: 'launch-error', runtime: 'vivari', cwd, durationMs: 0, exitCode: null, signal: null,
    stdout: '', stderr: '', output: { stdoutBytes: 0, stderrBytes: 0, truncated: false, stdoutFile, stderrFile }, diagnostics: [],
  };
  const diagnostic = (event: string, detail: string) => result.diagnostics.push({ elapsedMs: Date.now() - started, event, detail });
  const snapshot = (): JavascriptResult => ({ ...result, durationMs: Date.now() - started,
    stdout: buffers.stdout.toString('utf8'), stderr: buffers.stderr.toString('utf8'),
    output: { ...result.output }, diagnostics: [...result.diagnostics] });
  let entryWritten = false;
  try {
    if (!isAbsolute(cwd)) throw Error('cwd must be an absolute guest filesystem path');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw Error('timeoutMs must be an integer from 1 to 300000');
    if (typeof input.code !== 'string' || !input.code.trim()) throw Error('code must contain JavaScript');
    if (!statSync(cwd).isDirectory()) throw Error('cwd is not a directory: ' + cwd);
    if (options.signal.aborted) { result.status = 'cancelled'; diagnostic('cancelled', 'Cancelled before launch'); return snapshot(); }
    mkdirSync(directory, { recursive: true });
    writeFileSync(stdoutFile, ''); writeFileSync(stderrFile, '');
    writeFileSync(entry, input.code); entryWritten = true;
    diagnostic('launch', `Fresh Vivari JavaScript module; cwd=${cwd}; BROWSER_AGENT_GUEST=1; timeout=${timeoutMs}ms; source=${entry}`);
    await new Promise<void>((resolve) => {
      let finished = false;
      let requested: 'timeout' | 'cancelled' | 'failed' | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let stopDeadline: ReturnType<typeof setTimeout> | undefined;
      const child = spawn(options.executable ?? '/bin/node.js', [entry], {
        cwd, env: { ...process.env, BROWSER_AGENT_GUEST: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      result.status = 'running';
      const publish = () => {
        try { options.progress?.(snapshot()); }
        catch (error) { diagnostic('progress-error', String(error)); }
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer); clearTimeout(stopDeadline); clearInterval(heartbeat);
        options.signal.removeEventListener('abort', abort);
        publish(); resolve();
      };
      const stop = (reason: typeof requested, detail: string) => {
        if (finished || requested) return;
        requested = reason; result.status = reason!; diagnostic(reason!, detail);
        try {
          if (!child.kill('SIGKILL')) diagnostic('stop-error', 'Guest process did not acknowledge kill');
        } catch (error) { diagnostic('stop-error', String(error)); }
        stopDeadline = setTimeout(() => {
          diagnostic('stop-unconfirmed', 'No close event within 2000ms after SIGKILL; process termination is unconfirmed');
          finish();
        }, 2000);
      };
      const abort = () => stop('cancelled', String(options.signal.reason ?? 'Caller cancelled execution'));
      const capture = (channel: 'stdout' | 'stderr', chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        result.output[channel === 'stdout' ? 'stdoutBytes' : 'stderrBytes'] += bytes.length;
        const remaining = limit - buffers[channel].length;
        if (remaining > 0) buffers[channel] = Buffer.concat([buffers[channel], bytes.subarray(0, remaining)]);
        if (bytes.length > remaining) result.output.truncated = true;
        try { appendFileSync(channel === 'stdout' ? stdoutFile : stderrFile, bytes); }
        catch (error) { stop('failed', `Cannot retain ${channel}: ${String(error)}`); }
      };
      child.stdout.on('data', chunk => capture('stdout', chunk));
      child.stderr.on('data', chunk => capture('stderr', chunk));
      child.on('error', error => { if (finished) return; result.status = requested ?? 'launch-error'; diagnostic('process-error', error.stack ?? String(error)); finish(); });
      child.on('close', (code, signal) => {
        if (finished) return;
        result.exitCode = code; result.signal = signal;
        result.status = requested ?? (code === 0 ? 'completed' : 'failed');
        diagnostic('exit', `exitCode=${code}; signal=${signal ?? 'none'}`); finish();
      });
      timer = setTimeout(() => stop('timeout', `Exceeded ${timeoutMs}ms; terminating guest process`), timeoutMs);
      heartbeat = setInterval(publish, 500);
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
      publish();
    });
  } catch (error) {
    diagnostic('launch-error', error instanceof Error ? error.stack ?? error.message : String(error));
  } finally {
    if (entryWritten) {
      try { unlinkSync(entry); }
      catch (error) { diagnostic('cleanup-error', `Could not remove ${entry}: ${String(error)}`); }
    }
  }
  if (result.output.truncated) diagnostic('output-truncated', 'Inline output limited to 32768 bytes per channel; full output is in output.stdoutFile and output.stderrFile');
  return snapshot();
}
