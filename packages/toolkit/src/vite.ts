import { resolve } from 'node:path';

/** True inside the browser guest, where the app's dev server is the editor's preview. */
export const isGuest = () => process.env.BROWSER_AGENT_GUEST === '1';

/** Base path of the app: `/preview/<port>/` in the guest, `/` on the host. Also the
 * framework basename (React Router's `basename`). */
export function previewBase(): string {
  return isGuest() ? `/preview/${process.env.BROWSER_AGENT_PORT ?? '5173'}/` : '/';
}

export interface BrowserEditorOptions {
  /** The app module (relative to the Vite root) whose default export mounts the editor,
   * e.g. `src/editing.tsx`. In the guest it is replaced by a component that renders
   * nothing, so the preview does not offer an editor inside the editor. */
  module: string;
  /** The lazily imported module that pulls in the editor (e.g. `src/editor-panel.tsx`).
   * A host build then lists the chunks only it reaches in `editor-assets.json`, and the
   * server handler (`clientDir`) serves those only to authorized requests. */
  privateEntry?: string;
}

type IncomingLike = { url?: string; originalUrl?: string };

/** One Vite plugin for both sides. The application still owns its Vite config. */
export function browserEditor(options: BrowserEditorOptions): any {
  let editingModule: string;
  return {
    name: 'browser-editor', enforce: 'pre' as const,
    config() {
      // A dev server prebundles the browser entries in its first pass, together (they share
      // the chat code) and with their CommonJS dependencies converted; found later, they
      // would cost a second pass and a page reload when the editor is first opened.
      if (!isGuest()) return { optimizeDeps: { include: ['@kkrausse/browser-agent-toolkit/browser', '@kkrausse/browser-agent-toolkit/react'] } };
      return {
        base: previewBase(),
        // Outside node_modules/.vite: that tree is the read-only image.
        cacheDir: '.browser-editor-cache/vite',
        // The guest filesystem holds the workspace and its dependencies, nothing else.
        server: { fs: { strict: false } },
        // No source maps for optimized dependencies: they were two thirds of the cache
        // prepare ships (3.7 of 5.8 MB for the TODO app) and of every re-optimization.
        optimizeDeps: { esbuildOptions: { sourcemap: false } },
      };
    },
    configureServer(server: { middlewares: { use(handler: (request: IncomingLike, response: unknown, next: () => void) => void): void }; httpServer?: { prependListener(name: string, listener: (request: IncomingLike) => void): void; removeListener(name: string, listener: (request: IncomingLike) => void): void; once(name: string, listener: () => void): void } | null }) {
      if (!isGuest()) return;
      // A transport may deliver the path below the prefix; the server expects its base.
      const base = previewBase();
      const restore = (request: IncomingLike) => {
        if (request.url?.startsWith('/') && !request.url.startsWith(base)) request.url = base.slice(0, -1) + request.url;
        if (request.originalUrl?.startsWith('/') && !request.originalUrl.startsWith(base)) request.originalUrl = base.slice(0, -1) + request.originalUrl;
      };
      server.middlewares.use((request, _, next) => { restore(request); next(); });
      server.httpServer?.prependListener('upgrade', restore);
      server.httpServer?.once('close', () => server.httpServer?.removeListener('upgrade', restore));
    },
    configResolved(config: { root: string; assetsInclude?: (file: string) => boolean }) {
      editingModule = resolve(config.root, options.module);
      if (!isGuest() || typeof config.assetsInclude !== 'function') return;
      // Vite hashes its config, functions by their source text, to decide whether the
      // dependency-optimizer cache shipped by prepare is still valid. Its own
      // `assetsInclude` closes over an imported binding, and the browser runtime's module
      // loader rewrites such references, so the text (and the hash) differed between the
      // native run that produced the cache and the guest, which then threw the cache away
      // at every start. This wrapper has the same text on both sides.
      const original = config.assetsInclude;
      config.assetsInclude = function assetsInclude(file: string) { return original(file); };
    },
    transform(code: string, id: string) {
      // An optimized dependency has no source map here (see `config`). Vite then makes one up
      // for every such response, with the whole file as its content: react-dom's 1.1 MB chunk
      // went out as 6.1 MB and took the server 290 ms (native: 500-750 ms under load). A map
      // with empty mappings is Vite's way of saying "none, and do not invent one".
      if (isGuest() && id.includes('/.browser-editor-cache/vite/deps/')) return { code, map: { mappings: '' } };
    },
    load(id: string) {
      if (isGuest() && id.split('?')[0] === editingModule) return 'export default function Editing(){return null}';
    },
    generateBundle(this: { emitFile(file: { type: 'asset'; fileName: string; source: string }): void }, _: unknown, bundle: Record<string, any>) {
      const privateEntry = options.privateEntry;
      if (!privateEntry || isGuest()) return;
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
            for (const asset of [...(chunk.viteMetadata?.importedCss ?? []), ...(chunk.viteMetadata?.importedAssets ?? [])]) visited.add(asset);
          }
        };
        names.forEach(visit); return visited;
      };
      // Private: reachable from the editor entry and from no public entry.
      const publicFiles = walk(chunks.filter(chunk => chunk.isEntry).map(chunk => chunk.fileName), entry.fileName);
      const privateFiles = [...walk([entry.fileName])].filter(name => !publicFiles.has(name)).map(name => '/' + name);
      this.emitFile({ type: 'asset', fileName: 'editor-assets.json', source: JSON.stringify(privateFiles) });
    },
  };
}
