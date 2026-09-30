// Qualification-only policy, derived from the delivered 648 /api/session payload.
// Null is absence ONLY for these schema optional fields, never for unknown keys.
const optionalCreate=['id','title','agent','model','metadata','permissions'];
const check=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const object=(value:unknown):Record<string,unknown>=>{check(value!==null&&typeof value==='object'&&!Array.isArray(value),'Expected object');return value as Record<string,unknown>;};
export function qualifyRootPayload(bytes:Uint8Array){
 const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),body=object(JSON.parse(text));
 check(JSON.stringify(body)===text,'Ambiguous/non-SDK root JSON representation'); // In particular, duplicate keys cannot hide inheritance.
 check(Object.keys(body).every(key=>key==='location'||optionalCreate.includes(key)),'Unexpected root create settings');
 for(const key of optionalCreate)check(body[key]===null||body[key]===undefined,'Non-absent root setting: '+key);
 const location=object(body.location);
 check(Object.keys(location).every(key=>key==='directory'||key==='workspaceID'),'Unknown payload location');
 // Location.Ref uses the shipped optionalKey codec, NOT Schema.optional's nullable wire.
 check(location.directory==='/workspace'&&location.workspaceID===undefined,'Explicit unambiguous payload /workspace required');
 return body;
}
export function qualifyRootResult(value:unknown,projectID:string,previousIDs:readonly string[]){
 const root=object(value),location=object(root.location);
 check(typeof root.id==='string'&&/^ses_[A-Za-z0-9_-]+$/.test(root.id)&&!previousIDs.includes(root.id),'Fresh native root ID required');
 check(root.projectID===projectID&&location.directory==='/workspace'&&location.workspaceID===undefined,'Native root location/project mismatch');
 for(const key of ['parentID','fork','agent','model','permissions','metadata','subpath','revert','outcome'])check(root[key]===undefined,'Native root inheritance: '+key);
 return root.id as string;
}
export function createQualificationFence(){
 let fresh=false,inventoryEmpty=false,ownedRootID:string|undefined,creates=0;
 return {
  admitFreshOrigin(){fresh=true;},
  admitEmptyInventory(value:unknown){check(fresh&&!ownedRootID,'Inventory outside initial fresh-origin policy');check(Array.isArray(value)&&value.length===0,'Fresh origin contains persisted native sessions');inventoryEmpty=true;},
  ownRoot(id:string){check(inventoryEmpty&&!ownedRootID&&creates===1,'Root ownership not established');ownedRootID=id;},
  admit(request:Request,base:URL,bytes:Uint8Array){
   const url=new URL(request.url),prefix=base.pathname.endsWith('/')?base.pathname:base.pathname+'/';
   const path='/'+url.pathname.slice(prefix.length),sse=path==='/api/event'&&request.method==='GET';
   check(fresh&&url.origin===base.origin&&url.pathname.startsWith(prefix),'Forbidden route/origin');
   check(url.searchParams.getAll('location[directory]').length===1&&url.searchParams.get('location[directory]')==='/workspace'&&!url.searchParams.has('location[workspace]')&&!url.searchParams.has('location[workspaceID]')&&!request.headers.has('x-opencode-workspace')&&!request.headers.has('x-opencode-directory'),'Forbidden/ambiguous location');
   for(const [key,value] of base.searchParams)check(url.searchParams.getAll(key).length===1&&url.searchParams.get(key)===value,'Listener ownership mismatch');
   const globals=['/api/health','/api/config','/api/project/current','/api/plugin','/api/model','/api/model/default','/api/session/active'];
   const rootReads=ownedRootID?['','/message','/permission','/form'].map(suffix=>'/api/session/'+ownedRootID+suffix):[];
   const inventory=path==='/api/session'&&request.method==='GET'&&!ownedRootID;
   const create=path==='/api/session'&&request.method==='POST';
   for(const [key,value] of url.searchParams){
    if(base.searchParams.has(key)||key==='location[directory]')continue;
    const message=ownedRootID&&path==='/api/session/'+ownedRootID+'/message';
    check((inventory&&(key==='directory'&&value==='/workspace'||key==='order'&&value==='desc')||message&&(key==='order'&&value==='desc'||key==='limit'&&value==='50'))&&url.searchParams.getAll(key).length===1,'Unreviewed query setting: '+key);
   }
   check(request.method==='GET'&&(globals.includes(path)||rootReads.includes(path)||inventory||sse)||request.method==='POST'&&(create||path==='/api/plugin/await-activation'),'Forbidden route or unowned root');
   // Inventory remains global in this server: only the admitted fresh A0 source/caller may read it.
   if(inventory)check(fresh,'Initial inventory requires fresh origin');
   if(create){check(inventoryEmpty&&++creates===1&&!ownedRootID,'Only one native fresh root permitted');qualifyRootPayload(bytes);}
   else check(bytes.length===0,'Unexpected non-create request body');
   return {path,sse,create,inventory};
  },
 };
}
export async function captureQualificationRequest(request:Request,append:(record:any)=>void,preserve:(record:any)=>Promise<void>){
 const bytes=new Uint8Array(await request.arrayBuffer());
 const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource)),b=>b.toString(16).padStart(2,'0')).join('');
 let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));
 // No auth headers are copied. This is Fetch request body bytes, not TCP bytes.
 const record={method:request.method,url:request.url,bodyBase64:btoa(text),bytes:bytes.length,sha256,admission:'pending',authorization:'omitted'};
 append(record);await preserve(record);return {bytes,record};
}
