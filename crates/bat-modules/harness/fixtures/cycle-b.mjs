import defaultOfA, { bump, counter, readB } from './cycle-a.mjs';
import * as a from './cycle-a.mjs';
export let b = 1;
export function bumpB() { b++; }
// a.mjs has not been evaluated, but its function declarations exist.
export const callIntoA = { readB: readB(), defaultName: defaultOfA.name, defaultResult: defaultOfA() };
let tdz;
try { counter; tdz = 'no error'; } catch (error) { tdz = error.constructor.name; }
export { tdz };
export function liveCounter() { bump(); return [counter, a.counter]; }
