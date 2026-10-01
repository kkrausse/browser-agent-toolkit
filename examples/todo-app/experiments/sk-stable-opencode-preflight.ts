import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';

// Source-only blocker receipt. This does not launch a host, browser or guest.
// Do not silently weaken the requested per-root config-byte proof to prepare a UI.
const root=resolve(import.meta.dir,'../../..');
const prepared=join(root,'.diagnostics/single-kernel-e35eab4-full-fresh-2026-09-30-independent-17ef8e3/prepared');
const serverSha256='648140f53c48820106d4727fd29f1914f8f86a4e2c3f3430551eb9dd41a806b5';
const hash=(bytes:Uint8Array)=>new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
const manifestBytes=new Uint8Array(await Bun.file(join(prepared,'manifest.json')).arrayBuffer());
if(hash(manifestBytes)!=='57a149355cbfa1974da6637bbe6e437b23d7455d13f0b11d088c1146f3497c7f')throw Error('Reviewed manifest changed');
const manifest=JSON.parse(new TextDecoder().decode(manifestBytes));
const assets=manifest.assets.filter((asset:any)=>asset.kind==='file'&&asset.destination==='/app/server.js');
if(assets.length!==1||assets[0].sha256!==serverSha256)throw Error('Actual server selection changed');
const bytes=new Uint8Array(await Bun.file(join(prepared,assets[0].file)).arrayBuffer());
if(bytes.length!==27721680||hash(bytes)!==serverSha256)throw Error('Actual delivered bytes changed');
const lines=new TextDecoder().decode(bytes).split('\n');
const boundaries=[
 {name:'fixed-entrypoint',first:558823,last:558849,required:`config: { project: false, content: '{"snapshot":false}' }`},
 {name:'config-options-forwarding',first:558660,last:558677,required:'content: options9.config?.content'},
 {name:'project-discovery-disabled',first:449437,last:449471,required:'options7?.project === false ? []'},
 {name:'path-relative-substitution',first:447052,last:447097,required:'input.type === "path" ? path32.dirname(input.path) : input.dir'},
 {name:'shared-file-config',first:451074,last:451090,required:'substitute2({ type: "path", path: filepath, text: text5 })'},
 {name:'virtual-config-loading',first:451110,last:451137,required:'dir: location3.directory'},
 {name:'config-get-entries',first:558571,last:558571,required:'config7.entries()'},
];
const excerpts=boundaries.map(({required,...boundary})=>{
 const text=lines.slice(boundary.first-1,boundary.last).join('\n');
 if(!text.includes(required))throw Error('Reviewed source boundary changed: '+boundary.name);
 return {...boundary,sha256:hash(new TextEncoder().encode(text)),text};
});
const receipt={status:'blocked-before-runnable-preparation',serverSha256,manifestSha256:hash(manifestBytes),
 requestedRoots:['/workspace/projects/A','/workspace/projects/B'],
 blocker:'Frozen 648 disables project discovery and fixes token-free virtual config. Explicit location alone supplies no root-varying config document; shared path configs resolve substitutions relative to their own fixed paths.',
 sourceInferenceOnly:true,runnablePrepared:false,liveRuns:0,retentionAccepted:false,remoteZeroRef:false,
 backgroundWork:'models.fetch:true; global refresh and per-location subscribers remain server-owned, not drained',excerpts};
const output=resolve(process.argv[2]??join(root,'.diagnostics/sk-stable-opencode-blocker-'+crypto.randomUUID()));
await mkdir(output); // New directory only. Existing evidence is never overwritten.
await writeFile(join(output,'preflight.json'),JSON.stringify(receipt,null,2),{flag:'wx'});
console.log(JSON.stringify({output,status:receipt.status,serverSha256,runnablePrepared:false,liveRuns:0,retentionAccepted:false}));
