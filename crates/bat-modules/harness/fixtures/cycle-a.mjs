// A circular pair. Entry is this file; b.mjs runs first and, while this
// module's body has not started, calls a hoisted function declared here that
// reads a binding imported from b.mjs.
import { b, bumpB, callIntoA } from './cycle-b.mjs';
export let counter = 0;
export function bump() { counter++; }
export function readB() { return b; }
export default function () { return 'default-fn'; }
export const early = callIntoA;
bumpB();
export const seenB = b;
