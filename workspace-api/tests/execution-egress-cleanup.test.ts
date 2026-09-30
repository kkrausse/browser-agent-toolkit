// The kernel regression's rollback failure receipt can arrive before Runtime.stop.
// Exercise actual SDK launch/receipt handling; only the host relay is controlled.
import { expect, test } from 'bun:test';
import { Runtime } from '../src/runtime';
import { workspaceInternals, type Workspace } from '../src/workspace';
import type { Host } from '../src/host';

test('completed execution cleanup failure remains owned by Runtime', async () => {
  const listeners = new Set<(message: Record<string, unknown>) => void>();
  let execId = 0;
  const emit = (message: Record<string, unknown>) => { for (const listener of [...listeners]) listener(message); };
  const host = {
    nextExecution: 1, features: new Set<string>(),
    async request() { return { exists: true, isDir: false }; },
    on(listener: (message: Record<string, unknown>) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    post(type: string, message: Record<string, unknown>) {
      if (type === 'proc-spawn') { execId = Number(message.execId); emit({ type: 'proc-started', execId }); }
    },
  } as unknown as Host;
  const workspace = {} as Workspace;
  const distribution = { name: 'vivari', version: 'egress-fixture', assetBaseUrl: '/runtime/' };
  const state = { host, distribution, attached: false, clearing: false, closed: false };
  workspaceInternals.set(workspace, state);
  const runtime = await Runtime.start({ workspace, distribution });
  const execution = await runtime.node({ entry: '/fixture.js' });
  emit({ type: 'proc-exit', execId, code: 0, cleanupError: 'fixture unlink failed' });
  await execution.exited;
  await expect(execution.stop()).rejects.toThrow('fixture unlink failed');
  const stop = runtime.stop();
  await expect(stop).rejects.toThrow('workspace remains attached');
  expect(runtime.stop()).toBe(stop);
  expect(state.attached).toBe(true);
  await expect(Runtime.start({ workspace, distribution })).rejects.toThrow('already has an active runtime');
});
