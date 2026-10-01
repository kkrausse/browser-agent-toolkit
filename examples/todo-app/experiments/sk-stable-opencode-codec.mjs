// Node only: actual pinned bundle imports node:sea.
import {Api,Schema,Effect,makeSuccessSchema,HttpServerResponse,HttpApiSchema} from './pinned-codec.mjs';
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const record=JSON.parse(Buffer.concat(chunks).toString());
const allowed=record.method==='GET'&&['/api/health','/api/config','/api/project/current','/api/debug/location'].includes(record.path)||record.method==='POST'&&record.path==='/api/plugin/await-activation';
if(!allowed)throw Error('Outside dedicated finite toy');
const endpoint=Object.values(Api.groups).flatMap(group=>Object.values(group.endpoints)).find(e=>e.method===record.method&&e.path===record.path);
if(!endpoint)throw Error('Actual endpoint missing');
const url=new URL(record.url);
if(!['/workspace/projects/A','/workspace/projects/B'].includes(record.directory)||url.searchParams.getAll('location[directory]').length!==1||url.searchParams.get('location[directory]')!==record.directory||url.searchParams.has('location[workspace]')||record.requestBodyBytes!==0)throw Error('Explicit immutable location/zero-body contract missing');
if(['/api/config','/api/project/current','/api/plugin/await-activation'].includes(record.path)){
 const query=Schema.decodeSync(endpoint.query)({location:{directory:record.directory}},{onExcessProperty:'error'});
 if(query.location.directory!==record.directory)throw Error('Actual scoped query schema mismatch');
}
const bytes=Buffer.from(record.bodyBase64,'base64');
const domain=record.status===204?HttpApiSchema.NoContent.make():Schema.decodeSync([...endpoint.success][0])(JSON.parse(bytes.toString()));
const encoded=HttpServerResponse.toWeb(await Effect.runPromise(Schema.encodeEffect(makeSuccessSchema(endpoint))(domain)));
if(record.status!==encoded.status||!bytes.equals(Buffer.from(await encoded.arrayBuffer())))throw Error('Actual serializer byte/status parity mismatch');
const headers=new Headers(record.headers);for(const [key,value] of encoded.headers)if(headers.get(key)!==value)throw Error('Actual serializer header mismatch '+key);
console.log(JSON.stringify({qualified:true,method:record.method,path:record.path,status:encoded.status,bytes:bytes.length,encodedHeaders:[...encoded.headers],explicitDirectory:record.directory,requestBodyBytes:0}));
