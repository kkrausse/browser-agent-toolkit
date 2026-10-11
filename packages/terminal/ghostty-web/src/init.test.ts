import { expect, spyOn, test } from 'bun:test';
import { Ghostty } from './ghostty';

test('init shares concurrent loads, accepts either URL form, and retries failures', async () => {
  // A separate module instance keeps the singleton independent of terminal tests.
  const modulePath = './index.ts?initialization-regression';
  const { init, getGhostty } = await import(modulePath);
  let reject!: (reason: Error) => void;
  let resolve!: (ghostty: Ghostty) => void;
  const load = spyOn(Ghostty, 'load').mockImplementation(() => new Promise<Ghostty>((yes, no) => {
    resolve = yes;
    reject = no;
  }));
  try {
    const first = init({ wasmUrl: '/first.wasm' });
    const concurrent = init('/ignored.wasm');
    expect(first).toBe(concurrent);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenLastCalledWith('/first.wasm');
    reject(new Error('download failed'));
    await expect(first).rejects.toThrow('download failed');
    const retry = init('/retry.wasm');
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenLastCalledWith('/retry.wasm');
    const ghostty = {} as Ghostty;
    resolve(ghostty);
    await retry;
    expect(getGhostty()).toBe(ghostty);
    await init({ wasmUrl: '/later.wasm' });
    expect(load).toHaveBeenCalledTimes(2);
  } finally {
    load.mockRestore();
  }
});
