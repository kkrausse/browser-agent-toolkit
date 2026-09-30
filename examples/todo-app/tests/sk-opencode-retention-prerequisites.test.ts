import {describe, expect, test} from 'bun:test';
import {createRestrictedRetentionGate, retentionAdmission, retentionIdentityKeys, type RetentionIdentity, type RestrictedOwnership} from './sk-opencode-retention-prerequisites';

const identity = Object.fromEntries(retentionIdentityKeys.map(key => [key, key === 'directory' ? '/workspace' : 'unchanged-' + key])) as RetentionIdentity;
const ownership: RestrictedOwnership = {exclusive: true, reviewedPinnedHandlers: true, executionEverAdmitted: false, externalReaders: false, shellOrPTY: false, backgroundWork: false};
const health = () => Response.json({healthy: true, version: '2.0.3', pid: 1});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise, resolve};
};
const gate = (transport: (method: string, path: string, signal?: AbortSignal) => Promise<Response> = async () => health()) =>
  createRestrictedRetentionGate({before: identity, after: {...identity}, ownership, transport});

describe('SK retention preparation: never remote proof', () => {
  test('same directory is not source generation; all non-source identities must match', () => {
    expect(retentionAdmission(identity, {...identity}).mode).toBe('restricted-experiment-only');
    for (const key of retentionIdentityKeys) {
      expect(retentionAdmission(identity, {...identity, [key]: 'changed'})).toEqual({mode: 'restart-required', changes: [key]});
      expect(retentionAdmission(identity, {...identity, [key]: ''}).mode).toBe('restart-required');
    }
    expect(retentionAdmission(identity, {} as RetentionIdentity).changes).toHaveLength(retentionIdentityKeys.length);
  });
  test('ownership negatives cannot be silently waived', () => {
    for (const key of Object.keys(ownership) as (keyof RestrictedOwnership)[]) {
      expect(() => createRestrictedRetentionGate({before: identity, after: identity,
        ownership: {...ownership, [key]: !ownership[key]}, transport: async () => health()})).toThrow('ownership unproven');
    }
    expect(() => createRestrictedRetentionGate({before: identity, after: {...identity, plugins: 'new'}, ownership, transport: async () => health()})).toThrow('Restart required');
  });
  test('normal consumed response and joined local disposal produce inference, not eviction authorization', async () => {
    const g = gate();
    await g.request('GET', '/api/health');
    g.freeze();
    const local = deferred<void>();
    let finished = false;
    const sealing = g.seal(1000, () => local.promise).then(value => { finished = true; return value; });
    await Promise.resolve();
    expect(finished).toBe(false);
    local.resolve();
    const receipt = await sealing;
    expect(receipt.remoteProof).toBe(false);
    expect(receipt.evictionAuthorized).toBe(false);
    expect(receipt.releaseBasis).toBe('source-reviewed-zero-ref-inference-only');
    expect(receipt.finite).toHaveLength(1);
    await expect(g.request('GET', '/api/health')).rejects.toThrow('closed');
    await expect(g.seal(1000, async () => {})).rejects.toThrow('seal only once');
  });
  test('freeze waits for normal body EOF before disposal', async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const g = gate(async () => new Response(new ReadableStream({start(controller) { body = controller; }})));
    const reading = g.request('GET', '/api/health');
    await Promise.resolve();
    let disposed = false;
    g.freeze();
    const sealing = g.seal(1000, async () => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    body.enqueue(new TextEncoder().encode('{"healthy":true,"version":"2.0.3","pid":1}'));
    body.close();
    await reading;
    await sealing;
    expect(disposed).toBe(true);
  });
  test('concurrent reader attempt poisons inference without invoking a second transport', async () => {
    const late = deferred<Response>();
    let calls = 0;
    const g = gate(async () => { calls++; return late.promise; });
    const first = g.request('GET', '/api/health');
    const firstFailure = first.catch(error => error);
    await Promise.resolve();
    await expect(g.request('GET', '/api/config')).rejects.toThrow('concurrent');
    late.resolve(health());
    expect(String(await firstFailure)).toContain('concurrent');
    expect(calls).toBe(1);
    g.freeze();
    await expect(g.seal(1000, async () => {})).rejects.toThrow('concurrent');
  });
  test('abort ignored by transport remains failure even after normal body completion', async () => {
    const late = deferred<Response>();
    const g = gate(async () => late.promise);
    const controller = new AbortController();
    const reading = g.request('GET', '/api/health', controller.signal);
    const rejected = reading.catch(error => error);
    await Promise.resolve();
    controller.abort();
    late.resolve(health());
    expect(String(await rejected)).toContain('Cancelled');
    g.freeze();
    await expect(g.seal(1000, async () => {})).rejects.toThrow('Cancelled');
  });
  test('drain deadline preserves unresolved ownership and never invokes disposal', async () => {
    const late = deferred<Response>();
    const g = gate(async () => late.promise);
    const reading = g.request('GET', '/api/health');
    const rejected = reading.catch(error => error);
    await Promise.resolve();
    g.freeze();
    let disposed = false;
    await expect(g.seal(5, async () => { disposed = true; })).rejects.toThrow('deadline');
    expect(disposed).toBe(false);
    late.resolve(health());
    expect(String(await rejected)).toContain('deadline');
    await expect(g.request('GET', '/api/health')).rejects.toThrow('closed');
  });
  test('local cancellation finalizer failure is not a successful fence', async () => {
    const g = gate();
    await g.request('GET', '/api/health');
    g.freeze();
    await expect(g.seal(1000, async () => { throw Error('local finalizer failed'); })).rejects.toThrow('local finalizer failed');
  });
  test('unreviewed routes, SSE, execution, arbitrary sessions and DELETE never launch', async () => {
    for (const [method, path] of [
      ['GET', '/api/event'], ['POST', '/api/session'], ['POST', '/api/session/s/prompt'],
      ['POST', '/api/session/s/interrupt'], ['POST', '/api/session/s/wait'],
      ['GET', '/api/shell'], ['GET', '/api/pty'], ['POST', '/api/rpc/plugin/tool'],
      ['DELETE', '/api/debug/location'], ['GET', '/api/health?location[directory]=/elsewhere'],
      ['GET', '/api/session/old'], ['GET', '/api/config/extra'],
    ]) {
      let calls = 0;
      const g = gate(async () => { calls++; return health(); });
      await expect(g.request(method!, path!)).rejects.toThrow('Unreviewed');
      expect(calls).toBe(0);
    }
  });
  test('HTTP/codec/active-session/body failures poison normal completion', async () => {
    for (const response of [new Response('bad', {status: 500}), Response.json({_tag: 'Error'}),
      Response.json({healthy: true, version: 'other', pid: 1}), new Response('{'),
      new Response(new ReadableStream({start(controller) { controller.error(Error('body failure')); }}))]) {
      const g = gate(async () => response);
      await expect(g.request('GET', '/api/health')).rejects.toThrow();
      g.freeze();
      await expect(g.seal(1000, async () => {})).rejects.toThrow();
    }
    const g = gate(async () => Response.json({data: {s: {type: 'running'}}}));
    await expect(g.request('GET', '/api/session/active')).rejects.toThrow('Active sessions');
  });
  test('reviewed finite contracts remain narrow', async () => {
    const responses = new Map([
      ['/api/config', Response.json([{type: 'document'}])],
      ['/api/project/current', Response.json({id: 'same-project', directory: '/workspace', canonical: '/workspace'})],
      ['/api/session/active', Response.json({data: {}})],
      ['/api/plugin/await-activation', new Response(null, {status: 204})],
    ]);
    const g = gate(async (_, path) => responses.get(path)!);
    for (const path of responses.keys()) await g.request(path.endsWith('await-activation') ? 'POST' : 'GET', path);
    g.freeze();
    expect((await g.seal(1000, async () => {})).finite).toHaveLength(4);
  });
});
