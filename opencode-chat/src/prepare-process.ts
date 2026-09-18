import { createProcessOutput, type DiagnosticScope } from '@kev-browser-agent-kit/workspace/diagnostics';

/** Drain both pipes immediately, retaining the installer's normal terminal output. */
export async function runPreparationProcess(command: string[], options: { cwd: string; label: string; diagnostics: DiagnosticScope }): Promise<void> {
  const { diagnostics, label } = options;
  await diagnostics.stage('preparation.install', async () => {
    const child = Bun.spawn(command, { cwd: options.cwd, stdout: diagnostics.enabled ? 'pipe' : 'inherit', stderr: diagnostics.enabled ? 'pipe' : 'inherit' });
    const drain = async (stream: ReadableStream<Uint8Array> | number | undefined, name: 'stdout' | 'stderr') => {
      if (!stream || typeof stream === 'number') return;
      const output = createProcessOutput(message => diagnostics.record('host.output', { label: `${label}:${name}`, message }));
      const reader = stream.getReader();
      try { while (true) { const { done, value } = await reader.read(); if (done) break; process[name].write(value); output.push(value); } }
      finally { output.flush(); reader.releaseLock(); }
    };
    const [exitCode] = await Promise.all([child.exited, drain(child.stdout, 'stdout'), drain(child.stderr, 'stderr')]);
    if (exitCode) throw Error(`${label} failed (exit ${exitCode})`);
  }, { label });
}
