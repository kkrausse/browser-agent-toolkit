import {mkdir} from 'node:fs/promises'
import {resolve, join, relative, dirname} from 'node:path'
import {matchedReadinessBudgets,prospectivePolicy} from './matched-readiness'

// Offline only. Never installs, serves, modifies dist, or rebuilds runtime assets.
const root = resolve(import.meta.dir, '../../..')
const output = resolve(root, '.diagnostics', 'reviewed-client-prep-' + new Date().toISOString().replaceAll(/[:.]/g, '-'))
await mkdir(output)
const pin = '446df00f86d5d6d5d856a2e5deec0fac49f242fa'
async function command(args: string[], cwd = root) {
  const child = Bun.spawn(args, {cwd, stdout:'pipe', stderr:'pipe'})
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  await Bun.write(join(output, 'commands.log'), (await Bun.file(join(output, 'commands.log')).exists() ? await Bun.file(join(output, 'commands.log')).text() : '') + JSON.stringify({args,cwd,exit,stdout,stderr}) + '\n')
  if (exit) throw Error(`${args.join(' ')} failed: ${stderr || stdout}`)
  return stdout.trim()
}
const runtimeSource = join(output, 'runtime-source')
const verifierPath = 'examples/todo-app/tests/reset-verifier.js'
const approvedVerifier = await command(['git','show','b2b9c55:'+verifierPath])
const verifier = await Bun.file(join(root,verifierPath)).text()
if (approvedVerifier !== verifier.trim()) throw Error('Exclusive serial verifier changed from b2b9c55')
await Bun.write(join(output,'reset-verifier.js'),verifier)
await Bun.write(join(output,'driver-policy.json'),JSON.stringify({switchObservation:{timeoutMs:prospectivePolicy.observationMs},hydrationAndPdfRead:{timeoutMs:prospectivePolicy.verifierReadMs},outerWatchdogMs:prospectivePolicy.watchdogMs,serviceOnlyStop:'editorPerformanceExperiment.stopServices',sameGenerationRearm:'editorPerformanceExperiment.rearm',rearmsPerOrigin:1,rearmsMeasured:false},null,2))
await command(['git','worktree','add','--detach',runtimeSource,pin], join(root,'vendor/vivari'))
if (await command(['git','rev-parse','HEAD'],runtimeSource) !== pin || await command(['git','status','--porcelain'],runtimeSource)) throw Error('Pinned source not clean')
const frozen = join(root,'.diagnostics/phase4-clean-completion')
const identity = await Bun.file(join(frozen,'served-identity.json')).json()
if (identity.source !== pin) throw Error('Frozen source pin mismatch')
const hash = async (path: string) => { const bytes = new Uint8Array(await Bun.file(path).arrayBuffer()); return {bytes:bytes.length,sha256:new Bun.CryptoHasher('sha256').update(bytes).digest('hex')} }
const verified: Record<string, unknown> = {}
for (const [url, expected] of Object.entries(identity.served)) {
  if (url.startsWith('/client/')) continue
  const path = url === '/prepared/baseline/manifest.json' ? join(frozen,'server-output/baseline/manifest.json') : join(frozen,url.slice(1))
  const actual = await hash(path)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Frozen artifact mismatch: ' + url)
  verified[url] = actual
}
const manifest = await Bun.file(join(frozen,'server-output/baseline/manifest.json')).json()
let managedFileChecks = 0
for (const asset of [...manifest.assets.filter((entry: {kind:string})=>entry.kind==='file'),identity.payload.image,identity.payload.bundle]) {
  const path = join(frozen,'prepared',asset.file)
  const actual = await hash(path)
  if (actual.bytes !== asset.bytes || actual.sha256 !== asset.sha256) throw Error('Frozen payload mismatch: '+asset.file)
  managedFileChecks++
}
const tsc = join(root,'workspace-api/node_modules/typescript/bin/tsc')
const common = {target:'ES2023',module:'ESNext',moduleResolution:'Bundler',jsx:'react-jsx',strict:true,skipLibCheck:true,lib:['ES2023','DOM','DOM.Iterable'],typeRoots:[join(root,'workspace-api/node_modules/@types'),join(root,'opencode-chat/node_modules/@types')],types:['bun','react']}
async function declarations(name: string, source: string, files: string[], paths: Record<string,string[]>) {
  const config = join(output,name+'.tsconfig.json')
  await Bun.write(config,JSON.stringify({compilerOptions:{...common,rootDir:source,outDir:join(output,name),declaration:true,emitDeclarationOnly:true,paths},files},null,2))
  await command(['bun',tsc,'-p',config])
}
const hostSource = join(runtimeSource,'packages/core/src/host-sdk')
await declarations('host',hostSource,[join(hostSource,'index.ts')],{})
const workspace = join(output,'workspace')
const workspacePaths: Record<string,string[]> = {'@vivari/core/host':[join(output,'host/index.d.ts')],'@kev-browser-agent-kit/workspace':[join(root,'workspace-api/src/index.ts')]}
await declarations('workspace',join(root,'workspace-api/src'),['index.ts','react.tsx','delivery.ts','diagnostics.ts'].map(file=>join(root,'workspace-api/src',file)),workspacePaths)
for await (const file of new Bun.Glob('**/*.d.ts').scan(join(output,'host'))) await Bun.write(join(workspace,'vivari-host',file),Bun.file(join(output,'host',file)))
for await (const file of new Bun.Glob('**/*.d.ts').scan(workspace)) {
  const path = join(workspace,file)
  const target = relative(dirname(path),join(workspace,'vivari-host/index.js')).replaceAll('\\','/')
  await Bun.write(path,(await Bun.file(path).text()).replaceAll('@vivari/core/host',target.startsWith('.')?target:'./'+target))
}
const libraryPaths: Record<string,string[]> = {}
for (const name of ['index','react','delivery','diagnostics']) libraryPaths['@kev-browser-agent-kit/workspace'+(name==='index'?'':'/'+name)] = [join(workspace,name+'.d.ts')]
await declarations('chat',join(root,'opencode-chat/src'),[join(root,'opencode-chat/src/browser.ts')],libraryPaths)
const external = ['react','react/jsx-runtime','@kev-browser-agent-kit/workspace','@kev-browser-agent-kit/workspace/react','@kev-browser-agent-kit/workspace/delivery','@kev-browser-agent-kit/workspace/diagnostics']
for (const [source,entry,name] of [['workspace-api','index.ts','index'],['workspace-api','react.tsx','react'],['workspace-api','delivery.ts','delivery'],['workspace-api','diagnostics.ts','diagnostics'],['opencode-chat','browser.ts','browser']]) {
  const result = await Bun.build({entrypoints:[join(root,source!,'src',entry!)],outdir:join(output,source==='workspace-api'?'workspace':'chat'),naming:name+'.js',target:'browser',jsx:{runtime:'automatic',development:false},external,plugins:[{name:'pinned-host',setup(build){build.onResolve({filter:/^@vivari\/core\/host$/},()=>({path:join(hostSource,'index.ts')}))}}]})
  if (!result.success) throw new AggregateError(result.logs,'Source library build failed')
}
await Bun.write(join(workspace,'LICENSE.vivari'),Bun.file(join(runtimeSource,'LICENSE')))
for (const file of ['README.md','LOCAL-PACKAGES.md']) await Bun.write(join(workspace,file),Bun.file(join(root,'workspace-api',file)))
for (const file of ['README.md','PROVENANCE.md','LICENSE','LICENSE.marked','LICENSE.shadcn','LICENSE.upstream']) await Bun.write(join(output,'chat',file),Bun.file(join(root,'opencode-chat',file)))
await Bun.write(join(workspace,'package.json'),JSON.stringify({name:'@kev-browser-agent-kit/workspace',version:'0.1.0',type:'module',exports:Object.fromEntries(['index','react','delivery','diagnostics'].map(name=>[name==='index'?'.':'./'+name,{types:'./'+name+'.d.ts',import:'./'+name+'.js'}]))},null,2))
await Bun.write(join(output,'chat/package.json'),JSON.stringify({name:'@kev-browser-agent-kit/opencode-chat',version:'0.1.0',type:'module',license:'MIT',exports:{'./browser':{types:'./browser.d.ts',import:'./browser.js'}}},null,2))
const consumerPaths = {...libraryPaths,'@kev-browser-agent-kit/opencode-chat/browser':[join(output,'chat/browser.d.ts')]}
const consumerConfig = join(output,'consumer.tsconfig.json')
await Bun.write(consumerConfig,JSON.stringify({compilerOptions:{...common,noEmit:true,paths:consumerPaths},files:[join(root,'examples/todo-app/tests/performance-client.ts')]},null,2))
await command(['bun',tsc,'-p',consumerConfig])
const built = await Bun.build({entrypoints:[join(root,'examples/todo-app/tests/performance-client.ts')],outdir:join(output,'client'),target:'browser',plugins:[{name:'isolated-libraries',setup(build){
  build.onResolve({filter:/^@kev-browser-agent-kit\/workspace(?:\/(?:react|delivery|diagnostics))?$/},args=>({path:join(workspace,(args.path.split('/')[2]??'index')+'.js')}))
  build.onResolve({filter:/^@kev-browser-agent-kit\/opencode-chat\/browser$/},()=>({path:join(output,'chat/browser.js')}))
  build.onResolve({filter:/^react(?:\/jsx-runtime)?$/},args=>({path:require.resolve(args.path,{paths:[join(root,'workspace-api')]} )}))
}}]})
if (!built.success) throw new AggregateError(built.logs,'Actual consumer bundle failed')
const client = join(output,'client/performance-client.js')
const policyQuery = new URLSearchParams(Object.entries(prospectivePolicy).filter(([key])=>['listenMs','connectMs','hydrationMs','overallMs'].includes(key)).map(([key,value])=>['readiness.'+key,String(value)])).toString()
const deliveredPolicy = matchedReadinessBudgets(new URLSearchParams(policyQuery))
const clientText = await Bun.file(client).text()
for (const marker of ['Readiness cleanup unresolved; quiescence unproven','Aggregate services missing','services.same-generation.rearmed','phase9.full-reset-fallback']) {
  if (!clientText.includes(marker)) throw Error('Corrected packaged client marker missing: '+marker)
}
const packagedHashes: Record<string,unknown> = {}
for (const directory of ['workspace','chat','host']) for await (const file of new Bun.Glob('**/*.{js,d.ts}').scan(join(output,directory))) packagedHashes[directory+'/'+file] = await hash(join(output,directory,file))
const sourceHashes: Record<string,unknown> = {}
for (const path of ['workspace-api/src/react.tsx','workspace-api/src/service-readiness.ts','opencode-chat/src/browser.ts','examples/todo-app/tests/performance-client.ts','examples/todo-app/tests/matched-readiness.ts','examples/todo-app/tests/matched-qualification.ts','examples/todo-app/tests/matched-switch-live.ts','examples/todo-app/tests/prepare-reviewed-client.ts']) sourceHashes[path] = await hash(join(root,path))
const receipt = {output,pin,runtimeSource,version:identity.version,verified,managedFileChecks,sourceHashes,packagedHashes,verifier:await hash(join(output,'reset-verifier.js')),client:await hash(client),prospectivePolicy,policyQuery,deliveredPolicy,liveRuns:0,models:0}
await Bun.write(join(output,'receipt.json'),JSON.stringify(receipt,null,2))
console.log(JSON.stringify(receipt,null,2))
