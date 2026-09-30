import {expect,test} from 'bun:test';
import {runDiagnosticSpawnPlan} from './single-kernel-spawn-diagnostic-driver';
test('diagnostic modes are serial and stop at the first natural failure',async()=>{
  const seen:string[]=[];let active=0;
  await expect(runDiagnosticSpawnPlan(async mode=>{expect(++active).toBe(1);seen.push(mode);await Bun.sleep(1);--active;if(mode==='spawnSync')throw Error('natural spawnSync hang');})).rejects.toThrow('natural spawnSync hang');
  expect(seen).toEqual(['async','spawnSync']);
});
