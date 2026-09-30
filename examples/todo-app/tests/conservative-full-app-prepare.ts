// Offline preparation only. No listener, browser, guest or inference is started.
import { cp, mkdir, mkdtemp, readdir, symlink, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const input = '/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/kernel-egress-repair-3GsF7d';
const runtimeRevision = '33fa1359a003ca9c50cb3bc49699b99bc1a063f1';
const toolkitRevision = 'd0eec346dbc749db1c0cd82dd8aad0b27c1da363';
const version = '3debc8095c310192bac6062bb963e0ee09a431246cc8bafb7be2f5a1f2655a62';
const hash = async (path: string) => new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex');
async function walk(directory: string, relative = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
    const file = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isDirectory()) result.push(...await walk(directory, file));
    else if (entry.isFile()) result.push(file);
  }
  return result.sort();
}
async function verify(directory: string, hashes: Record<string, string>) {
  for (const [file, expected] of Object.entries(hashes)) {
    if (file.startsWith('/') || file.split('/').includes('..') || await hash(join(directory, file)) !== expected) throw Error('Artifact mismatch: ' + file);
  }
}
if (process.argv[2] === '--verify') {
  const stage = resolve(process.argv[3]!);
  const receipt = await Bun.file(join(stage, 'receipt.json')).json();
  await verify(stage, receipt.hashes);
  console.log(JSON.stringify({ verifiedFiles: Object.keys(receipt.hashes).length, receiptSha256: await hash(join(stage, 'receipt.json')), version: receipt.version }));
  process.exit(0);
}
if (process.argv[2] === '--run-copy') {
  const stage = resolve(process.argv[3]!), output = resolve(process.argv[4]!);
  if (!process.argv[3] || !process.argv[4] || output === stage || output.startsWith(stage + '/')) throw Error('Require a separate nonexisting live output');
  const receipt = await Bun.file(join(stage, 'receipt.json')).json();
  await verify(stage, receipt.hashes);
  await mkdir(output);
  for (const file of Object.keys(receipt.hashes)) {
    await mkdir(dirname(join(output, file)), { recursive: true });
    await cp(join(stage, file), join(output, file), { force: false, errorOnExist: true });
  }
  await Bun.write(join(output, 'receipt.json'), JSON.stringify({ ...receipt, output, frozenInput: stage }, null, 2));
  await verify(output, receipt.hashes);
  console.log(output);
  process.exit(0);
}
const candidateReceipt = await Bun.file(join(input, 'candidate-receipt.json')).json();
if (candidateReceipt.runtimeRevision !== runtimeRevision || candidateReceipt.toolkitRevision !== toolkitRevision || candidateReceipt.version !== version) throw Error('Wrong candidate');
await verify(join(input, 'candidate'), candidateReceipt.hashes);
const out = await mkdtemp('/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/conservative-full-app-');
let commandId = 0;
async function command(args: string[], cwd: string, env: Record<string, string | undefined> = process.env) {
  const process = Bun.spawn(args, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  await Bun.write(join(out, `command-${++commandId}.json`), JSON.stringify({ args, cwd, stdout, stderr, exit }, null, 2));
  if (exit) throw Error(args.join(' ') + '\n' + stdout + stderr);
  return stdout;
}
async function archive(repository: string, revision: string, name: string) {
  const directory = join(out, name);
  await mkdir(directory);
  const process = Bun.spawn(['git', 'archive', revision], { cwd: repository, stdout: 'pipe', stderr: 'pipe' });
  const [bytes, stderr, exit] = await Promise.all([new Response(process.stdout).arrayBuffer(), new Response(process.stderr).text(), process.exited]);
  if (exit) throw Error(stderr);
  await Bun.write(directory + '.tar', bytes);
  await command(['tar', '-xf', directory + '.tar', '-C', directory], out);
  return directory;
}
const source = await archive(root, toolkitRevision, 'toolkit-source');
const runtimeSource = await archive('/Users/kkrausse/Documents/repos/kkrausse/vivari-single-kernel', runtimeRevision, 'runtime-source');
if (await hash(source + '.tar') !== candidateReceipt.toolkitArchiveSha256 || await hash(runtimeSource + '.tar') !== candidateReceipt.runtimeArchiveSha256) throw Error('Source archive mismatch');
await command(['git', 'merge-base', '--is-ancestor', '691cd5aa0880349968773047402adec0bfeb16df', toolkitRevision], root);
await command(['git', 'merge-base', '--is-ancestor', '724909bff00c9c0994ecde7c767a218ae2af25a0', runtimeRevision], '/Users/kkrausse/Documents/repos/kkrausse/vivari-single-kernel');
for (const pkg of ['', 'workspace-api', 'opencode-chat', 'examples/todo-app']) await symlink(join(root, pkg, 'node_modules'), join(source, pkg, 'node_modules'));
const stage = join(out, 'frozen');
await mkdir(stage);
for (const directory of ['runtime', 'sdk', 'workspace', 'chat']) await cp(join(input, 'candidate', directory), join(stage, directory), { recursive: true });
await cp(join(input, 'candidate-receipt.json'), join(stage, 'owner-candidate-receipt.json'));
await cp(join(input, 'toolkit-source/vivari/.runtime/patched-build.json'), join(stage, 'native-build-provenance.json'));
// Recover only the independently pinned OpenCode application outputs, not old
// runtime/library/dependency bytes. The normal application verifier checks them.
const historical = join(root, '.diagnostics/single-kernel-e35eab4-full-attempt1');
const historicalReceipt = await Bun.file(join(historical, 'receipt.json')).json();
const applicationManifest = await Bun.file(join(historical, 'prepared/manifest.json')).json();
if (await hash(join(historical, 'prepared/manifest.json')) !== historicalReceipt.hashes['prepared/manifest.json']) throw Error('Historical application manifest changed');
const applicationInput = join(out, 'qualified-opencode');
await Bun.write(join(applicationInput, 'build-receipt.json'), applicationManifest.opencode.receipt);
for (const [file, expected] of Object.entries(JSON.parse(applicationManifest.opencode.receipt).outputs) as [string, any][]) {
  const asset = applicationManifest.assets.find((asset: any) => asset.destination === '/app/' + file);
  if (!asset || await hash(join(historical, 'prepared', asset.file)) !== expected.sha256) throw Error('Pinned OpenCode output mismatch');
  await cp(join(historical, 'prepared', asset.file), join(applicationInput, '.runtime/opencode-bun-server', file), { recursive: false }).catch(async error => {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(join(applicationInput, '.runtime/opencode-bun-server'), { recursive: true });
    await cp(join(historical, 'prepared', asset.file), join(applicationInput, '.runtime/opencode-bun-server', file));
  });
}
const native = await Bun.file(join(stage, 'native-build-provenance.json')).json();
for (const file of native.native.outputs) {
  if (await hash(join(input, 'runtime-source', file.name)) !== file.sha256 || await hash(join('/Users/kkrausse/Documents/repos/kkrausse/vivari-reset-completion-clean', file.name)) !== file.sha256) throw Error('Native provenance mismatch: ' + file.name);
}
const workspaceEntries = ['index', 'react', 'delivery', 'diagnostics', 'assets', 'prepare', 'vite', 'config'];
const chatEntries = ['index', 'browser', 'controller', 'editor', 'react', 'prepare', 'server', 'diagnostics', 'diagnostics-server'];
const peers = ['react', 'react/*', 'react-dom', 'react-dom/*', '@kev-browser-agent-kit/workspace', '@kev-browser-agent-kit/workspace/*'];
const hostPlugin = { name: 'matching-built-sdk', setup(builder: any) { builder.onResolve({ filter: /^@vivari\/core\/host$/ }, () => ({ path: join(stage, 'sdk/host.js') })); } };
for (const [pkg, entries, directory] of [['workspace-api', workspaceEntries, 'workspace'], ['opencode-chat', chatEntries, 'chat']] as const) {
  for (const entry of entries) {
    const node = ['assets', 'prepare', 'server', 'diagnostics-server', 'vite', 'config'].includes(entry);
    const file = pkg === 'opencode-chat' && entry === 'index' ? 'controller' : entry;
    const result = await Bun.build({ entrypoints: [join(source, pkg, 'src', file + (['editor', 'react'].includes(file) ? '.tsx' : '.ts'))], outdir: join(stage, directory), naming: entry + '.js', target: node ? 'bun' : 'browser', external: peers, plugins: [hostPlugin], jsx: { runtime: 'automatic', development: false } });
    if (!result.success) throw new AggregateError(result.logs);
  }
}
const paths: Record<string, string[]> = { '@vivari/core/host': [join(stage, 'sdk/host-sdk/index.d.ts')] };
const common = { target: 'ES2023', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx', strict: true, noUncheckedIndexedAccess: true, skipLibCheck: true, lib: ['ES2023', 'DOM', 'DOM.Iterable'], types: ['bun', 'react'], typeRoots: [join(root, 'workspace-api/node_modules/@types'), join(root, 'opencode-chat/node_modules/@types')] };
for (const [pkg, entries, directory] of [['workspace-api', workspaceEntries, 'workspace'], ['opencode-chat', chatEntries, 'chat']] as const) {
  const src = join(source, pkg, 'src');
  if (pkg === 'workspace-api') paths['@kev-browser-agent-kit/workspace'] = [join(src, 'index.ts')];
  const config = join(out, directory + '.tsconfig.json');
  await Bun.write(config, JSON.stringify({ compilerOptions: { ...common, declaration: true, emitDeclarationOnly: true, rootDir: src, outDir: join(stage, directory), paths }, files: entries.map(entry => join(src, entry + (['editor', 'react'].includes(entry) ? '.tsx' : '.ts'))) }));
  await command(['node', join(root, 'workspace-api/node_modules/typescript/bin/tsc'), '-p', config], source);
  for (const entry of entries) paths[(pkg === 'workspace-api' ? '@kev-browser-agent-kit/workspace' : '@kev-browser-agent-kit/opencode-chat') + (entry === 'index' ? '' : '/' + entry)] = [join(stage, directory, entry + '.d.ts')];
}
function libraries(builder: any) {
  hostPlugin.setup(builder);
  builder.onResolve({ filter: /^@kev-browser-agent-kit\/workspace(?:\/(react|delivery|diagnostics|assets|prepare))?$/ }, (args: any) => ({ path: join(stage, 'workspace', (args.path.split('/')[2] ?? 'index') + '.js') }));
  builder.onResolve({ filter: /^@kev-browser-agent-kit\/opencode-chat(?:\/(browser|editor|react|prepare|server|diagnostics|diagnostics-server))?$/ }, (args: any) => ({ path: join(stage, 'chat', (args.path.split('/')[2] ?? 'index') + '.js') }));
  builder.onResolve({ filter: /^@kev-browser-agent-kit\/opencode-chat\/editor.css$/ }, () => ({ path: join(stage, 'chat/editor.css') }));
  builder.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, (args: any) => ({ path: require.resolve(args.path, { paths: [join(root, 'opencode-chat')] }) }));
}
async function build(entry: string, target: 'browser' | 'bun', directory: string, extra?: (builder: any) => void) {
  const result = await Bun.build({ entrypoints: [entry], outdir: join(stage, directory), target, jsx: { runtime: 'automatic', development: false }, plugins: [{ name: 'separately-built-libraries-only', setup(builder) { libraries(builder); extra?.(builder); } }] });
  if (!result.success) throw new AggregateError(result.logs);
}
// Local package inputs contain only newly built matching library bytes/declarations.
for (const [pkg, directory] of [['workspace-api', 'workspace'], ['opencode-chat', 'chat']] as const) {
  const metadata = await Bun.file(join(source, pkg, 'package.json')).json();
  const relocate = (value: any): any => typeof value === 'string' ? value.replace('./dist/lib/', './').replace('./dist/', './') : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item)])) : value;
  await Bun.write(join(stage, directory, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, type: metadata.type, license: metadata.license, exports: relocate(metadata.exports), peerDependencies: metadata.peerDependencies, peerDependenciesMeta: metadata.peerDependenciesMeta, sideEffects: metadata.sideEffects }, null, 2));
  for (const file of pkg === 'workspace-api' ? ['README.md', 'LOCAL-PACKAGES.md'] : ['README.md', 'PROVENANCE.md', 'LICENSE', 'LICENSE.marked', 'LICENSE.shadcn', 'LICENSE.upstream']) await cp(join(source, pkg, file), join(stage, directory, file));
}
await cp(join(runtimeSource, 'LICENSE'), join(stage, 'workspace/LICENSE.vivari'));
await cp(join(stage, 'sdk/host-sdk'), join(stage, 'workspace/vivari-host'), { recursive: true });
for (const file of await walk(join(stage, 'workspace'))) if (file.endsWith('.d.ts')) {
  const { relative, dirname } = await import('node:path');
  const target = relative(dirname(join(stage, 'workspace', file)), join(stage, 'workspace/vivari-host/index.js')).replaceAll('\\', '/');
  await Bun.write(join(stage, 'workspace', file), (await Bun.file(join(stage, 'workspace', file)).text()).replaceAll('@vivari/core/host', target.startsWith('.') ? target : './' + target));
}
const packageInput = join(out, 'package-input');
await cp(join(stage, 'workspace'), join(packageInput, 'workspace-api/dist/lib'), { recursive: true });
await cp(join(stage, 'chat'), join(packageInput, 'opencode-chat/dist'), { recursive: true });
for (const file of ['src', 'package.json', 'bun.lock', 'vite.config.ts', 'react-router.config.ts', 'tsconfig.json']) await cp(join(source, 'examples/todo-app', file), join(packageInput, 'examples/todo-app', file), { recursive: true });
await build(join(source, 'examples/todo-app/tests/single-kernel-prepare-apps-consumer.ts'), 'bun', 'preparation-tools');
await command(['bun', join(stage, 'preparation-tools/single-kernel-prepare-apps-consumer.js')], source, { ...process.env, TMPDIR: out, SINGLE_KERNEL_APP_ROOT: join(packageInput, 'examples/todo-app'), SINGLE_KERNEL_APP_OUTPUT: stage, RUNTIME_DIR: join(stage, 'runtime'), OPENCODE_PACKAGE_DIR: applicationInput });
const tests = join(source, 'examples/todo-app/tests');
const consumerEntries = ['single-kernel-live-client.tsx', 'single-kernel-client.ts', 'single-kernel-reload-client.ts', 'single-kernel-cases-client.ts'];
await Bun.write(join(out, 'consumer.tsconfig.json'), JSON.stringify({ compilerOptions: { ...common, noUncheckedIndexedAccess: false, noEmit: true, allowJs: true, paths }, files: consumerEntries.map(entry => join(tests, entry)) }));
await command(['node', join(root, 'workspace-api/node_modules/typescript/bin/tsc'), '-p', join(out, 'consumer.tsconfig.json')], source);
// Only the old full-suite fixture's HOST addressing changes; the byte checks,
// workload, ownership assertions and time budgets are unmodified.
const fullClient = await Bun.file(join(tests, 'single-kernel-client.ts')).text();
const clientHostOrigin = "location.origin.replace(location.hostname,'host.vivari.internal')";
await Bun.write(join(tests, 'conservative-full-client-qa.ts'), fullClient.replace('fetchedBodyProbe(location.origin)', 'fetchedBodyProbe(' + clientHostOrigin + ')'));
for (const entry of consumerEntries.filter(entry => entry !== 'single-kernel-client.ts')) await build(join(tests, entry), 'browser', 'client');
await build(join(tests, 'conservative-full-client-qa.ts'), 'browser', 'client');
await cp(join(stage, 'client/conservative-full-client-qa.js'), join(stage, 'client/single-kernel-client.js'));
await build(join(source, 'workspace-api/tests/browser/test-library.ts'), 'browser', 'workspace');
await build(join(tests, 'single-kernel-cases-client.ts'), 'browser', 'client', builder => {
  builder.onResolve({ filter: /\/src\/(index|workspace)\.js$/ }, () => ({ path: join(stage, 'workspace/test-library.js') }));
});
// QA-only identity adaptation: original policy/actions/assertions are untouched.
const originalDriver = await Bun.file(join(tests, 'single-kernel-driver.ts')).text();
const driver = originalDriver.replace("const root=resolve(import.meta.dir,'../../..')", 'const root=' + JSON.stringify(source)).replace("receipt.revision!=='e35eab4af7a53ff08eb70c09df59c40b78bfdd67'", 'receipt.revision!==' + JSON.stringify(runtimeRevision));
await Bun.write(join(tests, 'conservative-full-app-driver-qa.ts'), driver);
await build(join(tests, 'conservative-full-app-driver-qa.ts'), 'bun', 'qa');
await build(join(tests, 'serve-single-kernel.ts'), 'bun', 'qa');
await Bun.write(join(stage, 'qa/driver-adaptation.json'), JSON.stringify({ originalDriverSha256: new Bun.CryptoHasher('sha256').update(originalDriver).digest('hex'), originalClientSha256: new Bun.CryptoHasher('sha256').update(fullClient).digest('hex'), changes: ['Pin admission from historical e35 to exact repaired 33fa135', 'Resolve original driver source hash checks against isolated committed archive', 'Address host fetched-body backend using host.vivari.internal rather than virtual guest loopback'], assertionsChanged: false, deadlinesChanged: false }, null, 2));
await Bun.write(join(stage, 'qa/live-host.ts'), `import {join} from 'node:path';
const stage=process.argv[2];
const receipt=await Bun.file(join(stage,'receipt.json')).json();
for(const [file,digest] of Object.entries(receipt.hashes))if(new Bun.CryptoHasher('sha256').update(await Bun.file(join(stage,file)).arrayBuffer()).digest('hex')!==digest)throw Error('Frozen artifact mismatch '+file);
const {createBrowserEditorHandler,browserEditorHeaders}=await import('./live-backend.js');
const {fetchRequestHandler,appRouter}=await import('./live-api.js');
const todos=new Map();
const editor=createBrowserEditorHandler({preparedDirectory:join(stage,'prepared'),runtimeDirectory:join(stage,'runtime'),providers:{}});
const headers={...browserEditorHeaders,'Cache-Control':'no-store'};
const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:240,async fetch(req){const path=new URL(req.url).pathname;
if(path==='/inspect-empty')return new Response('<title>Fresh acceptance origin inspection</title>',{headers});
if(path.startsWith('/editor/model/'))return new Response('Inference prohibited in this cohort',{status:403,headers});
if(path.startsWith('/editor/'))return await editor.fetch(req)??new Response('Not found',{status:404,headers});
if(path.startsWith('/api/'))return fetchRequestHandler({endpoint:'/api',req,router:appRouter,createContext:({req})=>({req,todos})});
if(path==='/editing-policy')return Response.json({allowed:true,fixture:'owned conservative acceptance'},{headers});
if(path==='/')return new Response('<!doctype html><link rel="stylesheet" href="/client/single-kernel-live-client.css"><div id="root"></div><script type="module" src="/client/single-kernel-live-client.js"></script>',{headers:{...headers,'Content-Type':'text/html'}});
if(!['/client/single-kernel-live-client.js','/client/single-kernel-live-client.css'].includes(path))return new Response('Not found',{status:404,headers});
const file=Bun.file(join(stage,path));return new Response(file,{headers:{...headers,'Content-Type':file.type}});
}});
await Bun.write(join(stage,'owned-live-origin.json'),JSON.stringify({url:String(server.url),pid:process.pid,output:stage,inferenceAllowed:false}));
console.log(JSON.stringify({url:String(server.url),pid:process.pid}));
process.on('SIGTERM',()=>{void server.stop(true).then(()=>process.exit(0));});
`);
await build(join(source, 'opencode-chat/src/server.ts'), 'bun', 'qa');
await cp(join(stage, 'qa/server.js'), join(stage, 'qa/live-backend.js'));
await Bun.write(join(source, 'examples/todo-app/tests/conservative-api-qa.ts'), "export {fetchRequestHandler} from '@trpc/server/adapters/fetch'; export {appRouter} from '../src/server/trpcRouter';");
await build(join(tests, 'conservative-api-qa.ts'), 'bun', 'qa');
await cp(join(stage, 'qa/conservative-api-qa.js'), join(stage, 'qa/live-api.js'));
const manifest = await Bun.file(join(stage, 'prepared/manifest.json')).json();
if (manifest.runtimeVersion !== version || manifest.dependencies.policy.runtimeVersion !== version) throw Error('Prepared runtime mismatch');
for (const asset of [...manifest.assets.filter((asset: any) => asset.kind === 'file'), manifest.bundle, manifest.image]) if (await hash(join(stage, 'prepared', asset.file)) !== asset.sha256) throw Error('Prepared asset mismatch');
const driverSources: Record<string, string> = {};
for (const file of ['single-kernel-driver.ts', 'matched-pair-driver.ts', 'matched-readiness.ts']) driverSources['examples/todo-app/tests/' + file] = await hash(join(tests, file));
const hashes: Record<string, string> = {};
for (const file of await walk(stage)) hashes[file] = await hash(join(stage, file));
await Bun.write(join(stage, 'receipt.json'), JSON.stringify({ output: stage, revision: runtimeRevision, toolkitRevision, version, topology: { policy: 'single-kernel' }, offline: false, prepared: true, hashes, driverSources, liveRuns: 0, models: 0, nativeRebuilt: false, sourceArchives: { toolkit: await hash(source + '.tar'), runtime: await hash(runtimeSource + '.tar') }, candidateInput: input, cacheRetention: false, processReuse: false, preparationOnly: true }, null, 2));
await verify(stage, hashes);
await verify(join(input, 'candidate'), candidateReceipt.hashes);
await Bun.write(join(out, 'handoff.json'), JSON.stringify({ stage, receiptSha256: await hash(join(stage, 'receipt.json')), files: Object.keys(hashes).length, preparedEntries: manifest.assets.length, candidateUnchanged: true, browserStarted: false, hostStarted: false, guestStarted: false, paidInference: false }, null, 2));
console.log(stage);
