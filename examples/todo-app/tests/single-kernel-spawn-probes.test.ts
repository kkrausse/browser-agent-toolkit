import {expect,test} from 'bun:test';
import {minimalChildProbe,minimalSpawnProbe,spawnProbeModes,spawnProbeFixture} from './single-kernel-spawn-probes';
test('minimal modes share child and existing file without emitting large binary data',()=>{
  expect(minimalChildProbe).toContain("readFileSync('/workspace/spawn-existing.txt'");
  expect(minimalChildProbe).toContain(JSON.stringify(spawnProbeFixture));
  expect(minimalChildProbe).not.toContain('Buffer.alloc');
  for(const mode of spawnProbeModes){const source=minimalSpawnProbe(mode);expect(source).toContain('/workspace/minimal-spawn-child.cjs');expect(source).toContain('PARENT_BEFORE_'+mode);expect(source).toContain('PARENT_AFTER_'+mode);expect(source).toContain('spawn-child-complete.txt');expect(source).not.toContain('setInterval');}
});
test('each mode uses its real public child_process operation',()=>{
  expect(minimalSpawnProbe('async')).toContain("cp.spawn('node'");
  expect(minimalSpawnProbe('spawnSync')).toContain("cp.spawnSync('node'");
  expect(minimalSpawnProbe('execSync')).toContain("cp.execSync('node /workspace/minimal-spawn-child.cjs'");
});
