import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';
import { browserPreviewBase } from './config';

/** Resource classification only; the host's Vite middleware owns authorization. */
export function isBrowserEditorModule(url: string, privateEntry?: string): boolean {
  const path = decodeURIComponent(url.split('?')[0]!);
  return !!(privateEntry && path.endsWith('/' + privateEntry))
    || /kev[-_]browser[-_]agent[-_]kit/.test(path) || /\/(opencode-chat|workspace-api)\//.test(path);
}

/** Excludes the app-owned editor entry from guest module resolution, including its imports. */
export function browserEditorBoundary(module: string, privateEntry?: string): Plugin {
  let boundary: string;
  return { name: 'browser-editor-boundary', enforce: 'pre',
    async config() {
      if (process.env.BROWSER_AGENT_GUEST === '1') return { base: browserPreviewBase(), cacheDir: '.browser-editor-cache/vite' };
      // Excluded file: packages still get Vite's immutable ?v= URLs. A same-version
      // rebuild must change the optimizer config hash, even with an unchanged lock.
      const hash = createHash('sha256');
      for (const name of ['@kev-browser-agent-kit/opencode-chat/editor', '@kev-browser-agent-kit/opencode-chat/diagnostics',
        '@kev-browser-agent-kit/opencode-chat/editor.css', '@kev-browser-agent-kit/workspace', '@kev-browser-agent-kit/workspace/react', '@kev-browser-agent-kit/workspace/diagnostics']) {
        hash.update(await readFile(new URL(import.meta.resolve(name))));
      }
      return { optimizeDeps: { exclude: ['@kev-browser-agent-kit/opencode-chat', '@kev-browser-agent-kit/workspace'],
        esbuildOptions: { define: { __BROWSER_EDITOR_BUILD__: JSON.stringify(hash.digest('hex')) } } } };
    },
    configureServer(server) {
      if (process.env.BROWSER_AGENT_GUEST !== '1') return;
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
