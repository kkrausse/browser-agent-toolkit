import {expect,test} from 'bun:test';
import {join,resolve} from 'node:path';
import {model,session} from '../../../opencode-chat/test/fixture';

const output=process.env.SK_OPENCODE_STAGE;
const codecTest=output?test:test.skip;
async function codec(record:unknown){
 const p=Bun.spawn(['node',join(resolve(output!),'sk-opencode-live-codec.mjs')],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});
 p.stdin.write(JSON.stringify(record));p.stdin.end();
 const [stdout,stderr,exit]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);return {stdout,stderr,exit};
}
const project={id:'project',directory:'/workspace',canonical:'/workspace'},location={directory:'/workspace',project};
const root={...session('ses_A'),location:{directory:'/workspace'}};
const fixtures:[string,string,number,unknown][]=[
 ['/api/health','GET',200,{healthy:true,version:'2.0.3',pid:1}],
 ['/api/config','GET',200,[{type:'document',path:'/workspace/.server/config/opencode/opencode.json',info:{username:'qualification'}}]],
 ['/api/project/current','GET',200,project],
 ['/api/plugin','GET',200,{location,data:[{id:'editor.javascript',source:{type:'local',path:'/workspace/.server/config/opencode/plugins/editor-javascript.js'},features:{server:true},state:{status:'active'}}]}],
 ['/api/model','GET',200,{location,data:[model]}],
 ['/api/plugin/await-activation','POST',204,undefined],
 ['/api/session','POST',200,{data:root}],
 ['/api/session/ses_A','GET',200,{data:root}],
 ['/api/session','GET',200,{data:[],cursor:{previous:null,next:null}}],
 ['/api/session/ses_A/message','GET',200,{data:[],cursor:{previous:null,next:null}}],
 ['/api/session/active','GET',200,{data:{}}],
 ['/api/session/ses_A/permission','GET',200,{data:[]}],
 ['/api/session/ses_A/form','GET',200,{data:[]}],
];
for(const [path,method,status,body] of fixtures)codecTest('actual delivered SK pinned HttpApi codec fixture '+method+' '+path,async()=>{
 const text=body===undefined?'':JSON.stringify(body);
 const headers=status===204?[]:[['content-type','application/json'],['content-length',String(Buffer.byteLength(text))]];
 const result=await codec({path,method,status,headers,bodyBase64:Buffer.from(text).toString('base64')});
 expect(result.exit,result.stderr).toBe(0);expect(JSON.parse(result.stdout).qualified).toBe(true);
},20000);
codecTest('actual codec rejects replacement codec shortcuts, wire drift and forbidden reset',async()=>{
 const text=JSON.stringify({healthy:true,version:'2.0.3',pid:1});
 const record={path:'/api/health',method:'GET',status:200,headers:[['content-type','application/json'],['content-length',String(Buffer.byteLength(text))]],bodyBase64:Buffer.from(text).toString('base64')};
 for(const patch of [{status:201},{headers:[['content-type','text/plain']]},{bodyBase64:Buffer.from(text+' ').toString('base64')},{path:'/api/debug/location',method:'DELETE',status:204,bodyBase64:''},{bodyBase64:Buffer.from('{}').toString('base64')}])expect((await codec({...record,...patch})).exit).not.toBe(0);
},20000);
test('host requires authorization without opening listener',async()=>{
 const p=Bun.spawn(['bun',join(import.meta.dir,'sk-opencode-live-serve.ts')],{env:{...process.env,SK_OPENCODE_AUTHORIZE_HOST:''},stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,exit]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
 expect(exit).not.toBe(0);expect(stdout).toBe('');expect(stderr).toContain('Parent browser-slot authorization required');
});
