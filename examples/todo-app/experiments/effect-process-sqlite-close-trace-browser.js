// QA-only lexical appendix to the unchanged emitted focused consumer.
// Installs before any run()/Worker construction; no constructor substitution.
(() => {
  const rows = [], identities = new WeakMap(), metadata = new WeakMap();
  let sequence = 0, identity = 0, dropped = 0, observerErrors = 0;
  const id = object => {
    let value = identities.get(object);
    if (!value) identities.set(object, value = ++identity);
    return value;
  };
  const record = (kind, data = {}) => {
    try {
      if (rows.length >= 2048) { dropped++; return; }
      rows.push({ sequence: ++sequence, kind, wall: Date.now(), mono: performance.now(), data });
    } catch { observerErrors++; }
  };
  const meta = worker => ({ worker: id(worker), ...(metadata.get(worker) ?? { urlProvenance: 'not-yet-correlated' }) });
  const locks = label => {
    try {
      void navigator.locks.query().then(value => record('locks.' + label, value), error => record('locks.error', { error: String(error) }));
    } catch (error) { record('locks.error', { error: String(error) }); }
  };
  const nativeWorker = Worker, nativeTerminate = Worker.prototype.terminate;
  Worker.prototype.terminate = function (...args) {
    record('native.terminate.call', meta(this));
    try {
      const result = Reflect.apply(nativeTerminate, this, args);
      record('native.terminate.return', { ...meta(this), returnType: typeof result });
      return result;
    } catch (error) { record('native.terminate.throw', { ...meta(this), error: String(error) }); throw error; }
  };
  const destroy = Host.prototype.destroy;
  Host.prototype.destroy = function (...args) {
    record('host.destroy.call', { ...meta(this.worker), deadBefore: this.dead });
    try {
      const result = Reflect.apply(destroy, this, args);
      record('host.destroy.return', { ...meta(this.worker), deadAfter: this.dead });
      return result;
    } catch (error) { record('host.destroy.throw', { ...meta(this.worker), error: String(error) }); throw error; }
  };
  function observePromise(kind, result, data) {
    // Return the original Promise unchanged; these branches never gate its caller.
    void result.then(() => { record(kind + '.fulfilled', data); if (kind === 'workspace.close') locks('close-fulfilled'); },
      error => record(kind + '.rejected', { ...data, error: String(error) }));
    return result;
  }
  function wrap(object, name, kind, data) {
    const original = object[name];
    object[name] = function (...args) {
      record(kind + '.call', data);
      try { return observePromise(kind, Reflect.apply(original, this, args), data); }
      catch (error) { record(kind + '.throw', { ...data, error: String(error) }); throw error; }
    };
  }
  const openHost = Host.open;
  Host.open = function (...args) {
    const result = Reflect.apply(openHost, this, args);
    void result.then(host => {
      // Derived from the admitted manifest/distribution and unchanged constructor,
      // not claimed as a directly observed native constructor argument.
      const url = new URL('assets/kernel-worker-a6UDx747.js', new URL(args[0].assetBaseUrl, location.href));
      url.searchParams.set('opfs-disable', '');
      url.searchParams.set('vivari-asset-base', new URL(args[0].assetBaseUrl, location.href).href);
      metadata.set(host.worker, { expectedUrl: url.href, urlProvenance: 'admitted-manifest-and-original-constructor' });
      record('host.open.fulfilled', meta(host.worker));
      wrap(host, 'flush', 'host.flush', meta(host.worker));
      host.worker.addEventListener('message', event => record('worker.message', { ...meta(host.worker), type: event.data?.type, hostDead: host.dead }));
    }, error => record('host.open.rejected', { error: String(error) }));
    return result;
  };
  const openWorkspace = Workspace.open;
  Workspace.open = function (...args) {
    const result = Reflect.apply(openWorkspace, this, args);
    void result.then(workspace => {
      const host = workspaceInternals.get(workspace)?.host;
      record('workspace.open.fulfilled', host ? meta(host.worker) : { unavailable: true });
      if (host) wrap(workspace, 'close', 'workspace.close', meta(host.worker));
    }, error => record('workspace.open.rejected', { error: String(error) }));
    return result;
  };
  const startRuntime = Runtime.start;
  Runtime.start = function (...args) {
    const result = Reflect.apply(startRuntime, this, args);
    void result.then(runtime => wrap(runtime, 'stop', 'runtime.stop', {}), error => record('runtime.start.rejected', { error: String(error) }));
    return result;
  };
  Object.defineProperty(window, '__sqliteCloseTraceQA', { value: {
    read: () => structuredClone({ rows, dropped, observerErrors, nativeConstructorUnchanged: Worker === nativeWorker,
      limits: ['page-native outer worker only; no native exit acknowledgement', 'expected URL is manifest-derived; correlate uniquely with actual CDP URL', 'no kernel RPC after workspace close'] }),
  } });
  record('observer.installed', { beforeWorkerConstruction: true, nativeConstructorUnchanged: Worker === nativeWorker });
})();
