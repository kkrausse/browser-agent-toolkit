// Distinct from qualification acceptance. Stop at uncertain ownership, never replace/evict/force.
export async function guardedFailureCleanup(steps:{dispose:()=>Promise<void>;finiteJoin:()=>Promise<void>;guestEOFJoin:()=>Promise<void>;zeroWork:()=>Promise<unknown>;workspaceClose:()=>Promise<void>}){
 const receipt:any={kind:'guarded-failure-cleanup',qualificationPassed:false,completed:false,steps:[]};
 for(const [name,action] of Object.entries(steps)){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{const result=await Promise.race([action(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Failure cleanup ownership uncertain: '+name)),20000);})]);receipt.steps.push({name,joined:true,...(result===undefined?{}:{result})});}
  catch(error){receipt.steps.push({name,joined:false,error:String(error)});receipt.error=String(error);return receipt;}
  finally{clearTimeout(timer);}
 }
 receipt.completed=true;return receipt;
}
