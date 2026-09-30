// Concrete external pinned schema fixtures; no guest/server execution or mocks
// presented as live responses. Protects the project's bare (not data-wrapped)
// response and readonly debug Ref[] shape used by the dedicated client.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const fixtures=[
 {path:'/api/health',method:'GET',status:200,body:'{"healthy":true,"version":"2.0.3","pid":42}'},
 {path:'/api/project/current',method:'GET',status:200,body:'{"id":"fixture-project","directory":"/workspace/projects/A","canonical":"/workspace/projects/A"}'},
 {path:'/api/debug/location',method:'GET',status:200,body:'[{"directory":"/workspace/projects/A"},{"directory":"/workspace/projects/B"}]'},
 {path:'/api/config',method:'GET',status:200,body:'[]'},
 {path:'/api/plugin/await-activation',method:'POST',status:204,body:''},
];
const receipts=[];
for(const fixture of fixtures){
 const bytes=Buffer.from(fixture.body),record={...fixture,directory:'/workspace/projects/A',url:'http://fixture.invalid'+fixture.path+'?location%5Bdirectory%5D=%2Fworkspace%2Fprojects%2FA',requestBodyBytes:0,headers:fixture.status===204?[]:[['content-type','application/json']],bodyBase64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
 const child=spawnSync(process.execPath,[new URL('./sk-stable-opencode-codec.mjs',import.meta.url).pathname],{input:JSON.stringify(record),encoding:'utf8'});
 if(child.status!==0)throw Error(child.stderr||child.stdout);receipts.push(JSON.parse(child.stdout));
}
console.log(JSON.stringify({kind:'actual648-external-schema-fixtures-not-live',receipts,liveRuns:0,retentionAccepted:false}));
