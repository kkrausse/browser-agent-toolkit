import { expect, test } from 'bun:test';
import { createProcessOutput } from '../src/process-output';
import { createControllerDiagnostics } from '../src/react-diagnostics';

test('process output survives split UTF-8, split credentials, and an unterminated final line', () => {
  const messages: unknown[] = [];
  const diagnostics = createControllerDiagnostics({ onDiagnostic: event => messages.push(event.data) });
  const output = createProcessOutput(message => diagnostics.record('guest.output', { message }));
  const bytes = new TextEncoder().encode('Vite failed — Authorization: Bearer hidden-value\nCannot find module');
  for (const byte of bytes) output.push(Uint8Array.of(byte));
  output.flush();
  expect(messages).toEqual([
    { message: 'Vite failed — Authorization: [redacted] [redacted]\n' },
    { message: 'Cannot find module' },
  ]);
});

test('long pending output is bounded and a failing sink cannot stop draining', () => {
  const messages: string[] = [];
  const output = createProcessOutput(message => messages.push(message));
  output.push(new TextEncoder().encode('x'.repeat(20000)));
  output.flush();
  expect(messages[0]?.length).toBe(6000);
  const diagnostics = createControllerDiagnostics({ onDiagnostic() { throw Error('sink offline'); } });
  expect(() => diagnostics.record('guest.output', { message: 'Vite failed' })).not.toThrow();
});
