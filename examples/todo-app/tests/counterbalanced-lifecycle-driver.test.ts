import {test,expect} from 'bun:test';
import {counterbalancedLifecyclePlan,runCounterbalancedLifecyclePair} from './counterbalanced-lifecycle-driver';
test('mounted lifecycle reverses blocked first-pair order without reversing fixtures or adding rearms',async()=>{
 expect(counterbalancedLifecyclePlan.map(s=>s.condition)).toEqual(['reuse','restart']);
 expect(counterbalancedLifecyclePlan.map(s=>s.port)).toEqual([43232,43233]);
 for(const step of counterbalancedLifecyclePlan)expect(step.markers).toEqual(['A0','B1','A2','B3','A4','B5']);
 let active=0;const seen:string[]=[];
 await runCounterbalancedLifecyclePair(async step=>{expect(++active).toBe(1);seen.push(step.condition);await Bun.sleep(1);--active;});
 expect(seen).toEqual(['reuse','restart']);
});
test('failed first counterbalanced condition prevents second condition and replacement',async()=>{
 const seen:string[]=[];
 await expect(runCounterbalancedLifecyclePair(async step=>{seen.push(step.condition);throw Error('stop whole pair');})).rejects.toThrow('stop whole pair');
 expect(seen).toEqual(['reuse']);
});
