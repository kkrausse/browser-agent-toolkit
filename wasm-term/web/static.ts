// Builds codex-local as a directory of static files: no relay, no server code, nothing of ours
// behind the page. Any file server can serve it, at any path, with no headers of its own.
//
//   bun static.ts [output directory]        default ../ports/codex/dist/static
//   PLAIN=1                                 ship the files uncompressed (to measure what inflating in the page costs)
//
//   index.html, client.js       the page (launcher without `?guest=`, the terminal with it)
//   sw.js                       its service worker (static-sw.ts): COOP/COEP, inflating `.gz`
//   worker.js, shell-worker.js  the program's Worker and the shell's
//   kernel.wasm, ghostty-vt.wasm, bat_sh.wasm      pty kernel, terminal emulator, shell
//   guests.json                 the one program, its settings and where its module is
//   guests/codex-local/codex-<hash>.wasm           the shipped codex-local module (ports/codex/dist/site-local)
//
// Files of 16 kB and more that the service worker serves are shipped once, as `<name>.gz`: a
// plain file server sends no `Content-Encoding`, so the worker inflates them
// (`DecompressionStream`, which has gzip and not brotli). The sample project is inside the module.
// Needs the builds the dev page needs: `bun run build` here, `BIN=local scripts/ship.sh` in ports/codex.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type { Manifest } from "../ports/codex/scripts/package";
import { codexLocalGuest, codexStaticGuestFor } from "../ports/codex/web/guest";
import type { GuestInfo } from "./guests";

const here = import.meta.dir;
const root = join(here, "..");
const out = resolve(process.argv[2] ?? join(root, "ports/codex/dist/static"));
const plain = process.env.PLAIN === "1";

const manifestPath = join(codexLocalGuest.site, "manifest.json");
if (!existsSync(manifestPath)) throw new Error(`No ${manifestPath}: run \`${codexLocalGuest.build}\``);
const module = (JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest).default;
if (!module) throw new Error(`${manifestPath} has no default build: run \`${codexLocalGuest.build}\``);
const modulePath = `guests/${codexLocalGuest.name}/${module.file}`;

/** Published path -> source file. */
const sources = new Map<string, string>([
  ["kernel.wasm", join(root, "kernel/target/wasm32-unknown-unknown/release/wasm_term_kernel.wasm")],
  ["ghostty-vt.wasm", Bun.fileURLToPath(import.meta.resolve("@random/ghostty-web/ghostty-vt.wasm"))],
  ["bat_sh.wasm", join(root, "host/sh/dist/bat_sh.wasm")],
  [modulePath, join(codexLocalGuest.site, module.file)],
]);
for (const [path, source] of sources) if (!existsSync(source)) throw new Error(`Missing ${source} (for ${path}): see "Run it" in wasm-term/README.md`);

const kept = new Set<string>();
function write(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(join(out, path)), { recursive: true });
  writeFileSync(join(out, path), data);
  kept.add(path);
}

const gzipped: Record<string, number> = {};
for (const [path, source] of sources) {
  const size = statSync(source).size;
  if (plain || size < 16 * 1024) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    copyFileSync(source, join(out, path));
    kept.add(path);
    continue;
  }
  gzipped[path] = size;
  const target = join(out, `${path}.gz`);
  kept.add(`${path}.gz`);
  // Named by its content and compressed when it was packaged: nothing to do twice.
  if (existsSync(target) && statSync(target).mtimeMs > statSync(source).mtimeMs) continue;
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(`${source}.gz`)) copyFileSync(`${source}.gz`, target);
  else writeFileSync(target, gzipSync(readFileSync(source), { level: 9 }));
}

// TCP_RELAY=wss://host/tcp bakes a standalone relay (web/tcp-relay-main.ts) into the page: net=tunnel becomes
// the default and the page works from any origin. Without it the build is net=direct unless `&tcp=` is given.
const tcpRelay = process.env.TCP_RELAY ?? "";
if (tcpRelay && !/^wss?:\/\//.test(tcpRelay)) throw new Error(`TCP_RELAY must be a ws:// or wss:// URL, got ${tcpRelay}`);

async function bundle(entries: string[], options: Partial<Parameters<typeof Bun.build>[0]> = {}): Promise<void> {
  const result = await Bun.build({ entrypoints: entries, target: "browser", format: "esm", sourcemap: "none", minify: true, define: { "process.env.WASM_TERM_STATIC": '"1"', "process.env.WASM_TERM_TCP_RELAY": JSON.stringify(tcpRelay) }, ...options });
  if (!result.success) throw new AggregateError(result.logs, `bundling ${entries.join(", ")} failed`);
  for (const output of result.outputs) write(output.path.split("/").pop()!.replace(/^static-/, ""), await output.text());
}
await bundle([join(here, "client.ts"), join(root, "host/worker.ts"), join(root, "host/shell-worker.ts")]);
// A classic script: `importScripts`-era service workers are what every browser registers.
await bundle([join(here, "static-sw.ts")], { format: "iife", define: { GZIPPED: JSON.stringify(gzipped) } });

const page = readFileSync(join(here, "index.html"), "utf8");
if (!page.includes('src="/client.js"')) throw new Error("index.html no longer loads /client.js: update static.ts");
write("index.html", page.replace('src="/client.js"', 'src="client.js"').replace("<title>wasm-term</title>", "<title>codex in this tab</title>"));
write("guests.json", JSON.stringify([{ ...codexStaticGuestFor(tcpRelay || undefined), module: modulePath } satisfies GuestInfo]));
write("README.txt", `codex-cli 0.162.0 in a browser tab, as static files (wasm-term, codex-local, net=direct).

Serve this directory with any file server and open it. It needs a secure context for its
service worker: http://localhost:<port> or https, not http://<another machine>.

  python3 -m http.server 3000        then open http://localhost:3000/   (localhost, not 127.0.0.1)

What works depends on the page's origin, because the program's requests go from the tab
straight to OpenAI and each host decides which origins a browser may call it from:
- an API key (api.openai.com) and the sign-in itself (auth.openai.com): any origin;
- a ChatGPT subscription (chatgpt.com/backend-api): only http://localhost:3000 and a few
  other fixed origins (also http://localhost:5173 and :8000), as observed on 2026-10-10.

Credentials and files are kept in this browser's IndexedDB for the page's origin; any other
page served from the same origin can read them. "Clear stored credentials" and "Forget saved
state" on the page delete them.
`);

const walk = (directory: string, prefix = ""): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(join(directory, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]);
for (const path of walk(out)) if (!kept.has(path)) rmSync(join(out, path));
const sizes = [...kept].map(path => [path, statSync(join(out, path)).size] as const).sort((a, b) => b[1] - a[1]);
for (const [path, size] of sizes) console.log(`${(size / 1e6).toFixed(2).padStart(8)} MB  ${path}`);
console.log(`Built ${out}: ${kept.size} files, ${(sizes.reduce((sum, [, size]) => sum + size, 0) / 1e6).toFixed(1)} MB${plain ? " (uncompressed)" : ""}; module ${module.file} (${(module.size / 1e6).toFixed(1)} MB to compile)`);
