import {test,expect} from 'bun:test';
import {createChatController} from '../../../opencode-chat/src/controller';
import {session,model,json} from '../../../opencode-chat/test/fixture';
import {assertPilotRoot,validatePilotResponse} from './reuse-pilot-contract';
import {createPilotFence,resetPilot,pilotRequestURL} from './reuse-pilot-fence';

const project={id:'project',directory:'/workspace',canonical:'/workspace'};
const location={directory:'/workspace',project};
const root=(id:string)=>({...session(id),location:{directory:'/workspace'}});
const fixtures: [string,string,number,unknown][] = [
  ['/api/health','GET',200,{healthy:true,version:'2.0.3',pid:1}],
  ['/api/config','GET',200,[{type:'document',path:'/workspace/.server/config/opencode/opencode.json',info:{username:'reuse-pilot-A'}}]],
  ['/api/project/current','GET',200,project],
  ['/api/plugin','GET',200,{location,data:[{id:'editor.javascript',source:{type:'local',path:'/workspace/.server/config/opencode/plugins/editor-javascript.js'},features:{server:true},state:{status:'active'}}]}],
  ['/api/model','GET',200,{location,data:[model]}],
  ['/api/plugin/await-activation','POST',204,undefined],
  ['/api/session','POST',200,{data:root('ses_A')}],
  ['/api/session/ses_A','GET',200,{data:root('ses_A')}],
  ['/api/session','GET',200,{data:[],cursor:{}}],
  ['/api/session/ses_A/message','GET',200,{data:[],cursor:{}}],
  ['/api/session/active','GET',200,{data:{}}],
  ['/api/session/ses_A/permission','GET',200,{data:[]}],
  ['/api/session/ses_A/form','GET',200,{data:[]}],
  ['/api/session/ses_A/interrupt','POST',200,{interrupted:false}],
  ['/api/debug/location','GET',200,[{directory:'/workspace'}]],
  ['/api/debug/location','DELETE',204,undefined],
];
for (const [path,method,status,body] of fixtures) test('packaged wire fixture '+method+' '+path,()=>{
  expect(()=>validatePilotResponse(path,method,status,body===undefined?'':JSON.stringify(body))).not.toThrow();
  expect(()=>validatePilotResponse(path,method,404,JSON.stringify({_tag:'SessionNotFoundError',sessionID:'ses_missing',message:'not found'}))).toThrow('HTTP 404');
  expect(()=>validatePilotResponse(path,method,status,JSON.stringify({error:'not data'}))).toThrow();
});
test('root assertion unwraps raw data; V2 workspaceID, optional settings and details are checked',()=>{
  expect(assertPilotRoot({data:root('ses_A')},'ses_A').id).toBe('ses_A');
  expect(()=>assertPilotRoot(root('ses_A'),'ses_A')).toThrow('envelope');
  for (const patch of [{parentID:'ses_old'},{fork:{}},{model:{}},{permissions:[]},{metadata:{}},{location:{directory:'/workspace',workspaceID:'wrk_other'}}])
    expect(()=>assertPilotRoot({data:{...root('ses_A'),...patch}},'ses_A')).toThrow();
  expect(()=>assertPilotRoot({data:root('ses_A')},'ses_B')).toThrow();
  expect(()=>validatePilotResponse('/api/session/ses_A/message','GET',200,'[]')).toThrow();
  expect(()=>validatePilotResponse('/api/session/ses_A/message','GET',200,'{"data":[],"cursor":{"next":null}}')).toThrow();
});
test('exact packaged 2.0.3 schema/handler and SDK response adaptation preflight',async()=>{
  const bundle=await Bun.file(new URL('../../../vivari/.runtime/opencode-release-2.0.3/.runtime/opencode-bun-server/server.js',import.meta.url)).text();
  expect(new Bun.CryptoHasher('sha256').update(bundle).digest('hex')).toBe('1df4bc41c0f6c7350da9d5953f3139586f760a7931fe411bdcabb3460098a929');
  for (const snippet of ['success: exports_Schema.Struct({ data: exports_session.Info })','success: exports_Schema.Array(exports_location.Ref)','success: exports_HttpApiSchema.NoContent','data: messages3,','previous: first ?','next: last3 ?','return { interrupted: yield* session.interrupt','return { data: yield* session ? read5','workspaceID: optional3(WorkspaceID)','metadata: Metadata3.pipe(optional3)','permissions: exports_permission.Ruleset.pipe(optional3)','id: location3.project.id','return yield* response2(catalog.model.available())','return yield* response2(exports_plugin22.Service.use','config7.entries()']) expect(bundle).toContain(snippet);
  const sdk=await Bun.file(new URL('../../../opencode-chat/node_modules/@opencode/client/dist/effect/generated/client.js',import.meta.url)).text();
  for(const name of ['EndpointSessionCreate','EndpointSessionGet','EndpointSessionActive','EndpointPermissionList','EndpointFormList']) {
    const adapter=sdk.slice(sdk.indexOf('const '+name+' ='),sdk.indexOf(';',sdk.indexOf('const '+name+' =')));
    expect(adapter).toContain('value.data');
  }
  expect(sdk.slice(sdk.indexOf('const EndpointMessageList ='),sdk.indexOf('const adaptGroupMessage'))).not.toContain('value.data');
});
test('actual controller + SDK offline cold, joined disposal, DELETE and fresh reacquire contracts',async()=>{
  const endpoint='http://offline/preview/4096/?__vv_listener=owned';
  const sessions: ReturnType<typeof root>[]=[]; let cancels=0; let evicted=false;
  const transport=async(input:string,init:RequestInit={})=>{
    const path=new URL(input).pathname.replace('/preview/4096','');
    if(path==='/api/event') return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({id:'evt_ready',created:1,type:'server.connected',data:{}})+'\r\n\r\n'));},cancel(){cancels++;}}),{headers:{'content-type':'text/event-stream'}});
    if(path==='/api/session'&&init.method==='POST') {const data=root('ses_'+(sessions.length+1));sessions.push(data);return json({data});}
    if(path==='/api/session') return json({data:sessions,cursor:{}});
    if(path==='/api/model') return json({location,data:[model]});
    if(path==='/api/plugin/await-activation') return new Response(null,{status:204});
    if(path==='/api/session/active') return json({data:{}});
    if(path.endsWith('/message')) return json({data:[],cursor:{}});
    if(/\/(permission|form)$/.test(path)) return json({data:[]});
    if(path==='/api/debug/location'&&init.method==='DELETE') {expect(cancels).toBe(1);evicted=true;return new Response(null,{status:204});}
    const data=sessions.find(s=>path==='/api/session/'+s.id); if(data) return json({data});
    throw Error('Unreviewed offline route '+path);
  };
  const first=createPilotFence(transport,false,endpoint,true);
  let chat=createChatController({endpoint:{url:endpoint,fetch:first.fetch},directory:'/workspace',startNewSession:true});
  const attach=async(fence:ReturnType<typeof createPilotFence>)=>{await chat.ready;const snapshot=chat.getSnapshot();expect(snapshot.error).toBeUndefined();expect(snapshot.messages).toEqual([]);expect(snapshot.execution).toBe('idle');return assertPilotRoot(await (await fence.fetch(pilotRequestURL(endpoint,'/api/session/'+snapshot.sessionID))).json(),snapshot.sessionID!);};
  try {
    const a=await attach(first);const admin=createPilotFence(transport,true,endpoint,true);let second=first;
    await resetPilot({fence:first,deadlineMs:1000,dispose:()=>chat.dispose(),evict:async()=>{await admin.fetch(pilotRequestURL(endpoint,'/api/debug/location'),{method:'DELETE'});},replace:async()=>{expect(evicted).toBe(true);},acquire:async()=>{second=createPilotFence(transport,false,endpoint,true);chat=createChatController({endpoint:{url:endpoint,fetch:second.fetch},directory:'/workspace',startNewSession:true});const b=await attach(second);expect(a.id).not.toBe(b.id);}});
    second.freeze();await second.drain(1000);await chat.dispose();expect(cancels).toBe(2);
    expect([...first.records,...second.records,...admin.records].every(r=>r.state==='normal'||r.state==='stream')).toBe(true);
    expect([...first.records,...second.records].some(r=>/interrupt|prompt|shell|rpc/.test(r.url))).toBe(false);
  } finally {await chat.dispose();}
});
