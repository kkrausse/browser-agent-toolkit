// An actual tarball install outside this checkout; no source path aliases.
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dir, "..");
const scratch = await mkdtemp(join(Bun.env.WORKSPACE_SMOKE_TMP ?? tmpdir(), "workspace-consumer-"));
async function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  const process = Bun.spawn(args, { cwd, stdout: "inherit", stderr: "inherit", env: { ...Bun.env, NODE_PATH: "", ...env } });
  if (await process.exited) throw Error(`Failed: ${args.join(" ")} (retained ${scratch})`);
}
await run(["bun", "pm", "pack", "--filename", join(scratch, "workspace.tgz"), "--quiet"], root);
const consumer = join(scratch, "consumer");
await mkdir(consumer);
await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "isolated-workspace-consumer", private: true, type: "module",
  dependencies: { "@kev-browser-agent-kit/workspace": "file:../workspace.tgz", react: "19.1.1", "react-dom": "19.1.1" },
  devDependencies: { typescript: "^5.9.3", "@types/react": "^19.2.18", "@types/react-dom": "^19.2.7", "@types/node": "^24" } }));
await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", jsx: "react-jsx", strict: true, noEmit: true, skipLibCheck: false }, include: ["*.tsx", "*.ts"] }));
await writeFile(join(consumer, "app.tsx"), `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceProvider, WorkspaceEditing, useWorkspace, type ControllerDiagnosticEvent } from '@kev-browser-agent-kit/workspace/react';
import { Workspace, Runtime, opfsStore, attachPreview, type Distribution } from '@kev-browser-agent-kit/workspace';
const distribution: Distribution = { name: 'vivari', version: 'pinned-at-deployment', assetBaseUrl: '/editor/runtime/' };
const events: ControllerDiagnosticEvent[] = [];
function App() { const { state } = useWorkspace(); return <p>{state.status}: normal app; no workers started</p>; }
createRoot(document.getElementById('root')!).render(<StrictMode><WorkspaceProvider onDiagnostic={e => { events.push(e); if(events.length > 20) events.shift(); }}><App /></WorkspaceProvider></StrictMode>);
const editing = <WorkspaceEditing allowed={false} enabled={false} start={async controller => { controller.signal.throwIfAborted(); }} isPreviewReady={() => false} renderEditor={() => null}><App /></WorkspaceEditing>;
export { Workspace, Runtime, opfsStore, attachPreview, distribution, editing };
`);
await writeFile(join(consumer, "assets.ts"), `import { copyRuntimeAssets, readRuntimeAssets } from '@kev-browser-agent-kit/workspace/assets';
const source = process.argv[2]!;
const manifest = await readRuntimeAssets(source);
await copyRuntimeAssets({ source, destination: './public/editor/runtime', expectedVersion: manifest.version });
console.log('Relocated runtime', manifest.version);
`);
await writeFile(join(consumer, "server.ts"), `import { authorizeEditorRequest, type EditorAuthorization } from '@kev-browser-agent-kit/workspace/server';
const policy: EditorAuthorization = () => false;
if ((await authorizeEditorRequest(new Request('http://localhost/editor'), policy))?.status !== 403) throw Error('Authorization failed');
`);
await writeFile(join(consumer, "lazy.tsx"), `import { renderToString } from 'react-dom/server';
import { WorkspaceProvider, WorkspaceEditing, WorkspaceController } from '@kev-browser-agent-kit/workspace/react';
globalThis.Worker = class { constructor() { throw Error('Eager worker'); } } as unknown as typeof Worker;
globalThis.fetch = (() => { throw Error('Eager fetch'); }) as unknown as typeof fetch;
const html = renderToString(<WorkspaceProvider><p>normal app</p></WorkspaceProvider>);
renderToString(<WorkspaceEditing allowed={false} enabled={true} start={async () => { throw Error('Eager recipe'); }} renderEditor={() => null}><p>normal app</p></WorkspaceEditing>);
if(!html.includes('normal app')) throw Error('SSR failed');
const events: unknown[] = [];
const controller = new WorkspaceController({ onDiagnostic: event => events.push(event) });
await controller.run('smoke', async () => { controller.log('Authorization=secret token=hidden'); });
if(JSON.stringify(events).includes('=secret') || JSON.stringify(events).includes('=hidden')) throw Error('Unredacted diagnostic');
await controller.dispose();
console.log('SSR/import lazy startup and public controller passed');
`);
await run(["bun", "install", "--ignore-scripts"], consumer);
await writeFile(join(consumer, "packaged-preview.ts"), await readFile(join(root, "tests/packaged-preview.ts")));
await run(["bun", "x", "--no-install", "tsc"], consumer);
await run(["bun", "build", "app.tsx", "--target", "browser", "--outdir", "build"], consumer);
await run(["bun", "lazy.tsx"], consumer);
await run(["bun", "lazy.tsx"], consumer, { NODE_ENV: "production" });
await run(["bun", "server.ts"], consumer);
await run(["bun", "packaged-preview.ts"], consumer);
const installed = join(consumer, "node_modules/@kev-browser-agent-kit/workspace");
if ((await readdir(installed)).some(name => ["src", "scripts", "node_modules"].includes(name))) throw Error("Private package content leaked");
const bundle = await readFile(join(consumer, "build/app.js"), "utf8");
if (/node:fs|\.runtime\/patched|\/api\/diagnostics/.test(bundle)) throw Error("Server/demo code leaked into browser bundle");
await mkdir(join(consumer, "public/editor"), { recursive: true });
// The consumer receives a standalone asset directory, not a path into the POC.
await run(["tar", "-czf", join(scratch, "runtime.tgz"), "-C", join(root, "dist/runtime"), "."], root);
const delivered = join(scratch, "delivered-runtime");
await mkdir(delivered);
await run(["tar", "-xzf", join(scratch, "runtime.tgz"), "-C", delivered], scratch);
await run(["bun", "assets.ts", delivered], consumer);
let files = 0, bytes = 0;
async function compare(directory = "") {
  for (const name of await readdir(join(delivered, directory))) {
    const path = join(directory, name);
    if ((await stat(join(delivered, path))).isDirectory()) { await compare(path); continue; }
    const original = await readFile(join(delivered, path)), relocated = await readFile(join(consumer, "public/editor/runtime", path));
    if (createHash("sha256").update(original).digest("hex") !== createHash("sha256").update(relocated).digest("hex")) throw Error(`Relocation mismatch: ${path}`);
    files++; bytes += original.length;
  }
}
await compare();
await writeFile(join(scratch, "receipt.json"), JSON.stringify({ consumer, files, bytes, checks: ["tarball install", "NodeNext declarations", "React browser build", "SSR/import lazy", "diagnostics redaction", "packaged React endpoint and independent-copy preview attachment", "public asset relocation hashes"] }, null, 2));
console.log(JSON.stringify({ scratch, files, bytes }));
