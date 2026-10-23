import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** True inside the browser guest, where the app's dev server is the editor's preview. */
export const isGuest = () => process.env.BROWSER_AGENT_GUEST === '1';

/** Base path of the app: `/preview/<port>/` in the guest, `/` on the host. Also the
 * framework basename (React Router's `basename`). `BROWSER_AGENT_BASE` (the path of the
 * runtime's `endpoint(port).url`) replaces the guest's default for an editor page that is
 * served below a path. */
export function previewBase(): string {
  return isGuest() ? process.env.BROWSER_AGENT_BASE || `/preview/${process.env.BROWSER_AGENT_PORT ?? '5173'}/` : '/';
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
type ModuleLike = { id: string | null; url: string };
type ClientEnvironmentLike = {
  moduleGraph: { invalidateModule(mod: ModuleLike, ...rest: unknown[]): void };
  transformRequest(url: string): Promise<{ code: string } | null>;
  hot: { send(payload: { type: 'full-reload'; path?: string }): void };
};
type WatcherLike = { on(event: 'all', listener: () => void): void };

/** React Router's dev manifest: the route table the running page was built from. */
const routeManifestId = '\0virtual:react-router/browser-manifest';

/** The route table in that module's code (`window.__reactRouterManifest={...}`), as a
 * comparable string: ids, nesting, paths and modules. Undefined when it does not parse. */
function routeTable(code: string): string | undefined {
  try {
    const scope: { __reactRouterManifest?: { routes?: Record<string, Record<string, unknown>> } } = {};
    new Function('window', code)(scope);
    const routes = Object.values(scope.__reactRouterManifest?.routes ?? {});
    return JSON.stringify(routes.map(r => [r.id, r.parentId, r.path, r.index, r.caseSensitive, r.module]).sort());
  } catch {
    return undefined;
  }
}

/** Reload the preview when React Router's route table changes. React Router reloads its
 * route config (routes.ts, files added or removed in the app directory) on the server and
 * invalidates its manifest module, but tells the open page nothing: its router keeps the
 * old table, so a route the agent just added was a 404 until someone reloaded the frame.
 * Natively a developer presses reload; nobody does in the preview. The manifest is
 * invalidated only after the new config is in place, so it is rebuilt then, and the page
 * reloads only when the table differs (not for a route module's new loader, which React
 * Router's own HMR applies). A rebuild fails while routes.ts names a file not written yet;
 * it is tried again after the next file event. */
function reloadOnRouteTableChange(client: ClientEnvironmentLike, watcher: WatcherLike | undefined, seen: { table?: string }) {
  const graph = client.moduleGraph;
  const invalidate = graph.invalidateModule.bind(graph);
  let url: string | undefined;
  let shown: string | undefined; // the open page's table while a rebuild is due
  let running = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    if (running) { again = true; return; }
    running = true;
    void client.transformRequest(url!)
      .then(() => {
        if (seen.table !== undefined && seen.table !== shown) client.hot.send({ type: 'full-reload', path: '*' });
        shown = undefined;
      }, () => {})
      .finally(() => {
        running = false;
        if (again) { again = false; schedule(); }
      });
  };
  const schedule = (ms = 0) => {
    if (shown === undefined) return;
    clearTimeout(timer);
    timer = setTimeout(check, ms);
  };
  graph.invalidateModule = (mod, ...rest) => {
    invalidate(mod, ...rest);
    if (mod.id !== routeManifestId || seen.table === undefined) return;
    url = mod.url;
    shown ??= seen.table;
    schedule();
  };
  watcher?.on('all', () => schedule(50));
}

const reactPackage = '@kkrausse/browser-agent-toolkit-react';

/** Whether `name` is in a `node_modules` at or above `from`. */
function installed(from: string, name: string): boolean {
  for (let directory = from; ; directory = dirname(directory)) {
    if (existsSync(join(directory, 'node_modules', name, 'package.json'))) return true;
    if (dirname(directory) === directory) return false;
  }
}

/** One Vite plugin for both sides. The application still owns its Vite config. */
export function browserEditor(options: BrowserEditorOptions): any {
  let editingModule: string;
  let root: string;
  let routeCompiler = false;
  const routes: { table?: string } = {};
  return {
    name: 'browser-editor', enforce: 'pre' as const,
    config(config: { root?: string }) {
      // A dev server prebundles the browser entries in its first pass, together (they share
      // the chat code) and with their CommonJS dependencies converted; found later, they
      // would cost a second pass and a page reload when the editor is first opened. The
      // React package is a separate install and is named only for an app that has it.
      if (!isGuest()) return { optimizeDeps: { include: ['@kkrausse/browser-agent-toolkit/browser', ...(installed(resolve(config.root ?? '.'), reactPackage) ? [reactPackage] : [])] } };
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
    configureServer(server: { environments?: { client?: ClientEnvironmentLike }; watcher?: WatcherLike; middlewares: { use(handler: (request: IncomingLike, response: unknown, next: () => void) => void): void }; httpServer?: { prependListener(name: string, listener: (request: IncomingLike) => void): void; removeListener(name: string, listener: (request: IncomingLike) => void): void; once(name: string, listener: () => void): void } | null }) {
      if (!isGuest()) return;
      if (server.environments?.client) reloadOnRouteTableChange(server.environments.client, server.watcher, routes);
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
    configResolved(config: { root: string; assetsInclude?: (file: string) => boolean; server?: { hmr?: unknown; preTransformRequests?: boolean } }) {
      root = config.root;
      editingModule = resolve(config.root, options.module);
      // React Router compiles route modules in a second dev server of its own (its "child
      // compiler": no HMR, no pre-transform requests), which gets this plugin too.
      routeCompiler = isGuest() && config.server?.hmr === false && config.server?.preTransformRequests === false;
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
      if (isGuest() && id === routeManifestId) routes.table = routeTable(code) ?? routes.table;
    },
    resolveId(id: string, importer?: string) {
      // routes.ts may name a route file before the agent writes it. If the manifest is built
      // in that gap (the reload above, or anyone loading the page), React Router's compiler
      // registers the URL under an unresolved id, keeps that entry when the file appears,
      // and then fails every manifest build ("There is a new version of the pre-bundle")
      // until the dev server restarts; that happens natively too. Resolving a missing file
      // to the path it will have keeps the entry valid once it exists.
      // React Router asks with no importer, which Vite's container turns into the root's index.html.
      if (!routeCompiler || (importer && !importer.endsWith('/index.html')) || !id.startsWith('/') || id.startsWith('/@') || id.includes('?') || id.includes('\0')) return;
      const file = join(root, id);
      if (file.startsWith(root + '/') && !existsSync(file) && !existsSync(id)) return file;
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
