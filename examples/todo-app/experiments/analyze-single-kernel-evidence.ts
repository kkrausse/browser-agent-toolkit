import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
if(!process.argv[2]||!process.argv[3])throw Error('Usage: analyze-single-kernel-evidence.ts <retained-evidence> <new-offline-summary-directory>');
const input=resolve(process.argv[2]),output=resolve(process.argv[3]);await mkdir(output);
const names=(await readdir(input)).filter(name=>/^\d+\.json$/.test(name)).sort();
const summary:any={input,output,cliCommands:names.length,cliFailures:[],stderrRecords:[],consoleErrorCount:0,pageErrorCount:0,errorCountRecords:[],logs:[],warnings:[],statuses:{},initiations:[]};
for(const name of names){
  const record=JSON.parse(await readFile(join(input,name),'utf8'));
  const result=JSON.parse(record.stdout);
  if(record.exit||!result.ok)summary.cliFailures.push({name,exit:record.exit,error:result.error});
  if(record.stderr)summary.stderrRecords.push({name,stderr:record.stderr});
  summary.consoleErrorCount+=result.aftermath?.consoleErrorCount??0;summary.pageErrorCount+=result.aftermath?.pageErrorCount??0;
  if(result.aftermath?.consoleErrorCount||result.aftermath?.pageErrorCount)summary.errorCountRecords.push({name,aftermath:result.aftermath,logs:result.logs});
  if(result.logs?.length)summary.logs.push({name,logs:result.logs});
  if(result.warnings?.length)summary.warnings.push({name,warnings:result.warnings});
  const status=result.value?.status;if(status)summary.statuses[status]=(summary.statuses[status]??0)+1;
  const scriptName=name.replace(/\.json$/,'.js');
  const script=await readFile(join(input,scriptName),'utf8');
  if(script.includes("const runs=window.singleKernelRuns"))summary.initiations.push({name,script:scriptName,result:result.value});
}
const census=JSON.parse(await readFile(join(input,'failure-census.json'),'utf8'));
summary.naturalFailure=census.evidence.error;summary.stages=census.evidence.stages.map((stage:any)=>stage.name);
summary.diagnostics=census.diagnostics;summary.targets=census.targets;
summary.eventKinds=[...new Set(census.evidence.events.map((event:any)=>event.event))];
summary.probeChannelCaptureAvailable=Object.hasOwn(census.evidence,'guestChannels');
summary.limitations=['CLI aftermath error counts are not a complete nested-worker console subscription','First cohort direct probe stderr was drained into a pending local promise, not retained incrementally','No HTTP listeners had been launched at the failure boundary','No inference that absent page errors prove absence of worker unhandled rejection'];
await writeFile(join(output,'summary.json'),JSON.stringify(summary,null,2),{flag:'wx'});
console.log(JSON.stringify({output,cliCommands:summary.cliCommands,cliFailures:summary.cliFailures.length,consoleErrorCount:summary.consoleErrorCount,pageErrorCount:summary.pageErrorCount,statuses:summary.statuses,initiations:summary.initiations.length,naturalFailure:summary.naturalFailure}));
