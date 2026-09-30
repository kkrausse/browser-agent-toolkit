export const spawnProbeModes=['async','spawnSync','execSync'] as const;
export type SpawnProbeMode=typeof spawnProbeModes[number];
export const spawnProbeFixture='single-kernel child reads the existing file\n';
export const minimalChildProbe=`const fs=require('node:fs');
const text=fs.readFileSync('/workspace/spawn-existing.txt','utf8');
if(text!==${JSON.stringify(spawnProbeFixture)})throw Error('Child existing-file read mismatch');
fs.writeFileSync('/workspace/spawn-child-complete.txt','read-completed');
process.stdout.write('CHILD_READ_COMPLETED\\n');`;

/** Identical child/input across modes. Tiny output isolates control dispatch from
 * large-buffer copying. Host joins exit and both drains; no timeout retry. */
export function minimalSpawnProbe(mode:SpawnProbeMode):string{
  const common=`const fs=require('node:fs'),cp=require('node:child_process');
process.stdout.write('PARENT_BEFORE_${mode}\\n');
const done=(bytes)=>{if(String(bytes)!=='CHILD_READ_COMPLETED\\n')throw Error('Child completion stdout');
if(fs.readFileSync('/workspace/spawn-child-complete.txt','utf8')!=='read-completed')throw Error('Child completion file');
process.stdout.write('PARENT_AFTER_${mode}\\n');};`;
  if(mode==='async')return common+`
const child=cp.spawn('node',['/workspace/minimal-spawn-child.cjs'],{cwd:'/workspace',stdio:['ignore','pipe','pipe']});
let stdout='',stderr='';child.stdout.on('data',b=>{stdout+=String(b);});child.stderr.on('data',b=>{stderr+=String(b);});
child.once('error',error=>{throw error;});child.once('close',(code,signal)=>{if(code!==0||signal)throw Error('Async child exit '+code+' '+signal+' '+stderr);done(stdout);});`;
  if(mode==='spawnSync')return common+`
const result=cp.spawnSync('node',['/workspace/minimal-spawn-child.cjs'],{cwd:'/workspace',encoding:'utf8',maxBuffer:65536});
if(result.error||result.status!==0||result.signal)throw Error('spawnSync failed '+String(result.error)+' '+result.status+' '+result.signal+' '+result.stderr);done(result.stdout);`;
  return common+`
done(cp.execSync('node /workspace/minimal-spawn-child.cjs',{cwd:'/workspace',encoding:'utf8',maxBuffer:65536}));`;
}
