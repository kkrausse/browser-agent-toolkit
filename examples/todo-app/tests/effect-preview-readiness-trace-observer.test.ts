import { expect, test } from 'bun:test';
import './effect-preview-readiness-trace-observer';

test('successful readiness does not retain later generated chat authorization', () => {
  const observer = (globalThis as any).effectPreviewReadinessTrace;
  observer.arm();
  observer.record('endpoint.transport', { metadata: { headers: { authorization: 'Basic ephemeralfixture' } } });
  observer.message('receive', { op: 'headers', headers: ['set-cookie', 'privatefixture', 'content-type', 'text/html'] });
  const json = JSON.stringify(observer.receipt);
  expect(json).not.toContain('ephemeralfixture');
  expect(json).not.toContain('privatefixture');
  expect(json).toContain('text/html');
  expect(observer.receipt.observerErrors).toBe(0);
});
