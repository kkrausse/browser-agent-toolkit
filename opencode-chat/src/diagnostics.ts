import { createDiagnosticReporter, type ControllerDiagnosticEvent } from '@kev-browser-agent-kit/workspace/diagnostics';
export { createDiagnosticReporter, createDiagnosticScope, sanitizeDiagnostic, type DiagnosticScope, type DiagnosticBatch, type ControllerDiagnosticEvent } from '@kev-browser-agent-kit/workspace/diagnostics';

/** Browser delivery is configured by the authorized host, independent of preparation. */
export function createBrowserEditorDiagnostics(options: { base?: string; enabled?: boolean; onDiagnostic?(event: ControllerDiagnosticEvent): void } = {}) {
  const endpoint = (options.base ?? '/editor/') + 'diagnostics';
  let lastWarning = -Infinity;
  const reporter = createDiagnosticReporter({ enabled: false, onError() {
    if (performance.now() - lastWarning > 30000) { lastWarning = performance.now(); console.warn('Editor diagnostics could not reach the host; buffered events will be retried.'); }
  }, async transport(batch) {
    const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch), keepalive: true, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw Error(`Editor diagnostics HTTP ${response.status}`);
  } });
  let connecting: Promise<void> | undefined;
  return {
    ...reporter,
    get enabled() { return reporter.enabled; },
    onDiagnostic(event: ControllerDiagnosticEvent): void {
      reporter.onDiagnostic(event);
      try { options.onDiagnostic?.(event); } catch {}
    },
    connect(): Promise<void> {
      return connecting ??= (async () => {
        if (options.enabled === false) return;
        try {
          const response = await fetch(endpoint + '/config', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(2000) });
          if (response.ok) reporter.setEnabled((await response.json()).enabled === true);
        } catch { /* A diagnostic outage must not block editing. */ }
      })();
    },
    attach(target: Window): () => void {
      const error = (event: ErrorEvent) => reporter.record('browser.error', event.error ?? event.message);
      const rejection = (event: PromiseRejectionEvent) => reporter.record('browser.rejection', event.reason);
      const flush = () => { void reporter.flush(); };
      target.addEventListener('error', error); target.addEventListener('unhandledrejection', rejection); target.addEventListener('pagehide', flush);
      return () => { target.removeEventListener('error', error); target.removeEventListener('unhandledrejection', rejection); target.removeEventListener('pagehide', flush); flush(); };
    },
  };
}
