import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { browserPreviewBase } from "./config.js";

/** Resource classification only; the host's Vite middleware owns authorization. */
export function isBrowserEditorModule(url: string, privateEntry?: string): boolean {
  const path = decodeURIComponent(url.split("?")[0]!);
  return !!(privateEntry && path.endsWith("/" + privateEntry))
    || /kev[-_]browser[-_]agent[-_]kit/.test(path) || /\/(opencode-chat|workspace-api)\//.test(path);
}

/** Generic preview/private-entry plumbing. The application still owns its Vite config. */
export function browserEditorBoundary(module: string, privateEntry?: string, buildInputs: () => (string | URL)[] = () => []): any {
  let boundary: string;
  return { name: "browser-editor-boundary", enforce: "pre" as const,
    async config() {
      if (process.env.BROWSER_AGENT_GUEST === "1") return { base: browserPreviewBase(), cacheDir: ".browser-editor-cache/vite" };
      const hash = createHash("sha256");
      for (const input of buildInputs()) hash.update(await readFile(typeof input === "string" && input.startsWith("file:") ? new URL(input) : input));
      return { optimizeDeps: { exclude: ["@kev-browser-agent-kit/opencode-chat", "@kev-browser-agent-kit/workspace"],
        esbuildOptions: { define: { __BROWSER_EDITOR_BUILD__: JSON.stringify(hash.digest("hex")) } } } };
    },
    configureServer(server: { middlewares: { use(callback: (request: { url?: string; originalUrl?: string }, response: unknown, next: () => void) => void): void }; httpServer?: { prependListener(name: string, callback: (request: { url?: string; originalUrl?: string }) => void): void; removeListener(name: string, callback: (request: { url?: string; originalUrl?: string }) => void): void; once(name: string, callback: () => void): void } }) {
      if (process.env.BROWSER_AGENT_GUEST !== "1") return;
      const base = browserPreviewBase();
      const restore = (request: { url?: string; originalUrl?: string }) => {
        if (request.url?.startsWith("/") && !request.url.startsWith(base)) request.url = base.slice(0, -1) + request.url;
        if (request.originalUrl?.startsWith("/") && !request.originalUrl.startsWith(base)) request.originalUrl = base.slice(0, -1) + request.originalUrl;
      };
      server.middlewares.use((request, _, next) => { restore(request); next(); });
      server.httpServer?.prependListener("upgrade", restore);
      server.httpServer?.once("close", () => server.httpServer?.removeListener("upgrade", restore));
    },
    configResolved(config: { root: string }) { boundary = resolve(config.root, module); },
    load(id: string) { if (process.env.BROWSER_AGENT_GUEST === "1" && id.split("?")[0] === boundary) return "export default function Editor(){return null}"; },
    generateBundle(this: { emitFile(file: { type: "asset"; fileName: string; source: string }): void }, _: unknown, bundle: Record<string, any>) {
      if (!privateEntry || process.env.BROWSER_AGENT_GUEST === "1") return;
      const chunks = Object.values(bundle).filter(item => item.type === "chunk");
      const entry = chunks.find(chunk => chunk.facadeModuleId?.endsWith("/" + privateEntry));
      if (!entry) return;
      const walk = (names: string[], skip?: string) => {
        const visited = new Set<string>();
        const visit = (name: string) => {
          if (visited.has(name) || name === skip) return;
          visited.add(name);
          const chunk = bundle[name];
          if (chunk?.type === "chunk") {
            for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) visit(dependency);
            for (const asset of [...(chunk.viteMetadata?.importedCss ?? []), ...(chunk.viteMetadata?.importedAssets ?? [])]) visited.add(asset);
          }
        };
        names.forEach(visit); return visited;
      };
      const publicFiles = walk(chunks.filter(chunk => chunk.isEntry).map(chunk => chunk.fileName), entry.fileName);
      const privateFiles = [...walk([entry.fileName])].filter(name => !publicFiles.has(name)).map(name => "/" + name);
      this.emitFile({ type: "asset", fileName: "editor-assets.json", source: JSON.stringify(privateFiles) });
    },
  };
}
