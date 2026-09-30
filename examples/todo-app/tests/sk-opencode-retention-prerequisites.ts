// Experiment-only offline preparation. Not imported by the app, and not an
// eviction/reset API. Normal HTTP completion is NOT a remote release receipt.
export const retentionIdentityKeys = [
  'serverBundle', 'runtime', 'mount', 'directory', 'workspaceID', 'cwd',
  'environment', 'dependencies', 'plugins', 'configuration', 'owner', 'endpoint',
] as const;
export type RetentionIdentity = Record<typeof retentionIdentityKeys[number], string>;
export function retentionAdmission(before: RetentionIdentity, after: RetentionIdentity) {
  const changes = retentionIdentityKeys.filter(key =>
    typeof before[key] !== 'string' || !before[key] ||
    typeof after[key] !== 'string' || !after[key] || before[key] !== after[key]);
  return {mode: changes.length ? 'restart-required' : 'restricted-experiment-only', changes} as const;
}

export interface RestrictedOwnership {
  exclusive: boolean;
  reviewedPinnedHandlers: boolean;
  executionEverAdmitted: boolean;
  externalReaders: boolean;
  shellOrPTY: boolean;
  backgroundWork: boolean;
}
export interface FiniteReceipt {
  method: string;
  path: string;
  status: number;
  bytes: number;
}

// Intentionally smaller than the mounted-controller baseline allowlist. No SSE,
// arbitrary session IDs, create/prompt, tools, RPC, filesystem or debug routes.
function validateFinite(method: string, path: string, response: Response, bytes: Uint8Array) {
  const text = new TextDecoder().decode(bytes);
  if (method === 'POST' && path === '/api/plugin/await-activation') {
    if (response.status !== 204 || text !== '') throw Error('Expected empty activation 204');
    return;
  }
  if (response.status !== 200) throw Error('Expected finite 200');
  const value = JSON.parse(text);
  if (value === null || typeof value !== 'object' || value._tag || value.error) throw Error('Invalid success envelope');
  if (path === '/api/health') {
    if (value.healthy !== true || value.version !== '2.0.3' || !Number.isInteger(value.pid) || value.pid <= 0) throw Error('Pinned health contract');
  } else if (path === '/api/config') {
    if (!Array.isArray(value) || !value.every(entry => entry && typeof entry.type === 'string')) throw Error('Config entries contract');
  } else if (path === '/api/project/current') {
    if (!['id', 'directory', 'canonical'].every(key => typeof value[key] === 'string')) throw Error('Project contract');
  } else if (path === '/api/session/active') {
    if (!value.data || typeof value.data !== 'object' || Array.isArray(value.data) || Object.keys(value.data).length !== 0) throw Error('Active sessions forbid retention');
  } else throw Error('Unreviewed finite response');
}

export function createRestrictedRetentionGate(options: {
  before: RetentionIdentity;
  after: RetentionIdentity;
  ownership: RestrictedOwnership;
  // Injected only; no global fetch, origin, credentials, runtime or host ownership.
  transport(method: string, path: string, signal?: AbortSignal): Promise<Response>;
}) {
  const admission = retentionAdmission(options.before, options.after);
  if (admission.mode === 'restart-required') throw Error('Restart required: ' + admission.changes.join(', '));
  const ownership = {...options.ownership};
  if (!ownership.exclusive || !ownership.reviewedPinnedHandlers || ownership.executionEverAdmitted ||
      ownership.externalReaders || ownership.shellOrPTY || ownership.backgroundWork) throw Error('Restricted ownership unproven; restart required');
  let frozen = false;
  let failure: unknown;
  let pending: Promise<unknown> | undefined;
  let sealed = false;
  const receipts: FiniteReceipt[] = [];
  const poison = (error: unknown) => { failure ??= error; return error; };
  const request = (method: string, path: string, signal?: AbortSignal): Promise<void> => {
    if (frozen || sealed || failure) return Promise.reject(Error('Retention admission closed'));
    const allowed = method === 'GET' && ['/api/health', '/api/config', '/api/project/current', '/api/session/active'].includes(path)
      || method === 'POST' && path === '/api/plugin/await-activation';
    if (!allowed || pending) return Promise.reject(poison(Error('Unreviewed or concurrent reader; restart required')));
    if (signal?.aborted) return Promise.reject(poison(Error('Cancelled reader; remote release uncertain')));
    const abort = () => { poison(Error('Cancelled reader; remote release uncertain')); };
    signal?.addEventListener('abort', abort, {once: true});
    // Defer invocation so pending is set before transport can reenter the gate.
    const task = Promise.resolve().then(async () => {
      if (failure) throw failure;
      const response = await options.transport(method, path, signal);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (failure || signal?.aborted) throw failure ?? Error('Cancelled reader');
      validateFinite(method, path, response, bytes);
      receipts.push({method, path, status: response.status, bytes: bytes.length});
    }).catch(error => { throw poison(error); }).finally(() => {
      signal?.removeEventListener('abort', abort);
      pending = undefined;
    });
    pending = task;
    return task;
  };
  return {
    request,
    freeze() { frozen = true; },
    async seal(deadlineMs: number, disposeLocal: () => Promise<void>) {
      if (!frozen || sealed) throw Error('Freeze first; seal only once');
      sealed = true;
      if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw poison(Error('Invalid seal deadline'));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // A timeout poisons the gate; it never cancels or pretends to join work.
        await Promise.race([
          (async () => {
            await pending;
            if (failure) throw failure;
            await disposeLocal();
            if (failure) throw failure;
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(poison(Error('Drain deadline; remote release uncertain'))), deadlineMs);
          }),
        ]);
        return Object.freeze({
          scope: 'exclusive-serial-normally-consumed-reviewed-finite-handlers' as const,
          remoteProof: false as const,
          releaseBasis: 'source-reviewed-zero-ref-inference-only' as const,
          // This is a preparation receipt, not authorization to evict a location.
          evictionAuthorized: false as const,
          finite: receipts.map(receipt => Object.freeze({...receipt})),
        });
      } catch (error) { throw poison(error); }
      finally { clearTimeout(timer); }
    },
  };
}
