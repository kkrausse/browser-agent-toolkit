import {expect, test} from 'bun:test';
import {fixture, json, session} from '../../../opencode-chat/test/fixture';
import {qualifyMountedRetentionCandidate} from './sk-opencode-retention-mounted-candidate';

test('actual controller mounts through injected mock transport; no eviction, source write or retention acceptance', async () => {
  const f = fixture();
  f.override = (url, init) => {
    if (url.pathname.endsWith('/health')) return json({healthy: true, version: '2.0.3', pid: 1});
    if (url.pathname.endsWith('/project/current')) return json({id: 'project', directory: '/workspace', canonical: '/workspace'});
    if (url.pathname.endsWith('/session/ses_new') || (url.pathname.endsWith('/session') && init.method === 'POST')) {
      return json({data: {...session('ses_new'), location: {directory: '/workspace'}}});
    }
  };
  let renders = 0, codecs = 0, ownershipChecks = 0;
  const result = await qualifyMountedRetentionCandidate({endpoint: f.endpoint, generation: 'A0', previousSessionIDs: ['ses1', 'ses2'],
    requestMs: 1000, readSourceMarker: async () => 'A0', verifyOwnedIdentity: async () => { ownershipChecks++; },
    // Mock-only! This callback is deliberately NOT a pinned codec parity proof.
    verifyPinnedCodec: async () => { codecs++; }, render: () => { renders++; }});
  expect(result.status).toBe('mounted-qualification-only');
  expect(result.retentionAccepted).toBe(false);
  expect(result.remoteProof).toBe(false);
  expect(result.session.id).toBe('ses_new');
  expect(result.snapshot.messages).toEqual([]);
  expect(result.wire.length).toBe(codecs);
  expect(ownershipChecks).toBe(2);
  expect(renders).toBeGreaterThan(0);
  expect(f.cancels).toBe(1);
  expect(f.calls.some(call => call.init.method === 'DELETE' || /prompt|shell|pty|interrupt/.test(call.url.pathname))).toBe(false);
});
