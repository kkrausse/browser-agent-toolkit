import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { browserPreviewBase } from './config';
import type { EditorAuthorization } from '@kev-browser-agent-kit/workspace/server';

/** Excludes the app-owned editor entry from guest module resolution, including its imports. */
export function browserEditorBoundary(module: string, privateEntry?: string, authorize?: EditorAuthorization): Plugin {
  let boundary: string;
  return { name: 'browser-editor-boundary', enforce: 'pre',
    config() { return process.env.BROWSER_AGENT_GUEST === '1' ? { base: browserPreviewBase(), cacheDir: '.browser-editor-cache/vite' }
      : { optimizeDeps: { exclude: ['@kev-browser-agent-kit/opencode-chat', '@kev-browser-agent-kit/workspace'] } }; },
    configureServer(server) {
      if (process.env.BROWSER_AGENT_GUEST !== '1') {
        server.middlewares.use(async (request, response, next) => {
          let path: string;
          try { path = decodeURIComponent((request.url ?? '').split('?')[0]!); } catch { response.statusCode = 400; response.end('Bad path'); return; }
          const sensitive = (privateEntry && path.endsWith('/' + privateEntry))
            || /kev[-_]browser[-_]agent[-_]kit/.test(path) || /\/(opencode-chat|workspace-api)\//.test(path);
          if (!sensitive) { next(); return; }
          let allowed = false;
          try {
            const headers = new Headers();
            for (const [name, value] of Object.entries(request.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
            allowed = !!await authorize?.(new Request(`http://${request.headers.host}${request.url}`, { headers }));
          } catch { /* fail closed */ }
          if (allowed) next();
          else { response.statusCode = 403; response.setHeader('Cache-Control', 'no-store'); response.end('Editing is not authorized'); }
        });
        return;
      }
      const base = browserPreviewBase();
      // The workspace bridge strips its transport prefix. Restore the framework's
      // deployment base before Vite/React Router handle HTTP and HMR upgrades.
      const restore = (request: { url?: string; originalUrl?: string }) => {
        if (request.url?.startsWith('/') && !request.url.startsWith(base)) request.url = base.slice(0, -1) + request.url;
        if (request.originalUrl?.startsWith('/') && !request.originalUrl.startsWith(base)) request.originalUrl = base.slice(0, -1) + request.originalUrl;
      };
      server.middlewares.use((request, _, next) => { restore(request); next(); });
      server.httpServer?.prependListener('upgrade', restore);
      server.httpServer?.once('close', () => server.httpServer?.removeListener('upgrade', restore));
    },
    configResolved(config) { boundary = resolve(config.root, module); },
    load(id) {
      if (process.env.BROWSER_AGENT_GUEST === '1' && id.split('?')[0] === boundary) return 'export default function Editor(){return null}';
    },
    generateBundle(_, bundle) {
      if (!privateEntry || process.env.BROWSER_AGENT_GUEST === '1') return;
      const chunks = Object.values(bundle).filter(item => item.type === 'chunk');
      const entry = chunks.find(chunk => chunk.facadeModuleId?.endsWith('/' + privateEntry));
      if (!entry) return;
      const walk = (names: string[], skip?: string) => {
        const visited = new Set<string>();
        const visit = (name: string) => {
          if (visited.has(name) || name === skip) return;
          visited.add(name);
          const chunk = bundle[name];
          if (chunk?.type === 'chunk') {
            for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) visit(dependency);
            const metadata = (chunk as typeof chunk & { viteMetadata?: { importedCss: Set<string>; importedAssets: Set<string> } }).viteMetadata;
            for (const asset of [...(metadata?.importedCss ?? []), ...(metadata?.importedAssets ?? [])]) visited.add(asset);
          }
        };
        names.forEach(visit); return visited;
      };
      const publicFiles = walk(chunks.filter(chunk => chunk.isEntry).map(chunk => chunk.fileName), entry.fileName);
      const privateFiles = [...walk([entry.fileName])].filter(name => !publicFiles.has(name)).map(name => '/' + name);
      this.emitFile({ type: 'asset', fileName: 'editor-assets.json', source: JSON.stringify(privateFiles) });
    },
  };
}
