import {diagnoseWorkspace} from '@kev-browser-agent-kit/workspace';
import {observeBrowserCases, drainLogs, log} from '../../../workspace-api/tests/browser/harness';
import {singleKernelCases} from './single-kernel-cases';
import {assertSingleKernelDiagnostics, assertZeroWork} from '../tests/single-kernel-contract';

const evidence:any={status:'idle',cases:singleKernelCases.map(({name,steps})=>({name,steps:steps.length})),steps:[],topology:[]};
let active=false,failed=false;
const attempted=new Set<string>();
observeBrowserCases(async(phase,workspace)=>{
  const diagnostics=await diagnoseWorkspace(workspace);assertSingleKernelDiagnostics(diagnostics);
  if(phase==='stopped'){assertZeroWork(diagnostics);if((diagnostics as any).spawnCapture?.ownedSpills!==0)throw Error('Focused case left owned spawn spills');}
  evidence.topology.push({phase,diagnostics});log('single-kernel-topology',{phase,diagnostics});
});
const api={evidence,async run(index:number,step:number){
  const token=index+':'+step;
  if(active||failed||attempted.has(token))throw Error('Case busy, failed, or previously attempted');
  const test=singleKernelCases[index];if(!test?.steps[step])throw Error('Unknown contract step');
  active=true;attempted.add(token);evidence.status='running';
  try{
    await test.steps[step]!();await drainLogs();
    evidence.steps.push({name:test.name,index,step,status:'passed'});evidence.status='ready';return {name:test.name,index,step,status:'passed'};
  }catch(error){failed=true;evidence.status='failed';evidence.error=String(error);throw error;}
  finally{active=false;document.querySelector('pre')!.textContent=JSON.stringify(evidence,null,2);}
}};
(window as any).singleKernelCases=api;
document.querySelector('pre')!.textContent=JSON.stringify(evidence,null,2);
