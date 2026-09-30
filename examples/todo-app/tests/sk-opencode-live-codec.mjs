// Executed by Node: the pinned bundle imports node:sea, unsupported by Bun.
import {Api, Schema, Effect, makeSuccessSchema, HttpServerResponse, HttpApiSchema} from './pinned-codec.mjs';
const chunks=[];
for await (const chunk of process.stdin) chunks.push(chunk);
const record=JSON.parse(Buffer.concat(chunks).toString());
const allowed=record.method==='GET' && (['/api/health','/api/config','/api/project/current','/api/plugin','/api/model','/api/model/default','/api/session','/api/session/active'].includes(record.path) || /^\/api\/session\/[A-Za-z0-9_-]+(?:\/(message|permission|form))?$/.test(record.path)) || record.method==='POST' && ['/api/session','/api/plugin/await-activation'].includes(record.path);
if(!allowed) throw Error('Unqualified codec route');
const endpoint=Object.values(Api.groups).flatMap(g=>Object.values(g.endpoints)).find(e=>e.method===record.method && (e.path===record.path || e.path.replace(':sessionID',record.path.split('/')[3])===record.path));
if(!endpoint) throw Error('Missing pinned endpoint');
const bytes=Buffer.from(record.bodyBase64,'base64');
const success=[...endpoint.success][0];
let domain=record.status===204?HttpApiSchema.NoContent.make():Schema.decodeSync(success)(JSON.parse(bytes.toString()));
if((record.path==='/api/session'&&record.method==='GET')||record.path.endsWith('/message')) {
  if(domain.cursor.previous!==null||domain.cursor.next!==null) throw Error('Qualification requires unpaginated fresh inventory');
  domain={...domain,cursor:{previous:undefined,next:undefined}};
}
const encoded=HttpServerResponse.toWeb(await Effect.runPromise(Schema.encodeEffect(makeSuccessSchema(endpoint))(domain)));
const encodedBytes=Buffer.from(await encoded.arrayBuffer());
if(record.status!==encoded.status||!bytes.equals(encodedBytes)) throw Error('Pinned transport status/body parity mismatch');
const actual=new Headers(record.headers);
for(const [key,value] of encoded.headers) if(actual.get(key)!==value) throw Error('Pinned transport header parity mismatch: '+key);
console.log(JSON.stringify({qualified:true,method:record.method,path:record.path,status:encoded.status,encodedHeaders:[...encoded.headers],bytes:bytes.length}));
