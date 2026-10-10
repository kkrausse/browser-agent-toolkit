export let count = 0;
export function inc() { return ++count; }
export const obj = { method() { return this === undefined ? 'unbound' : typeof this; } };
export function tag(strings, ...values) { return (this === undefined ? 'unbound:' : 'bound:') + strings.raw.join('|') + values.join(','); }
export class Base { static who() { return 'base'; } }
export default function named() { return 'named-default'; }
export { count as "string-name", inc as default2 };
export var late;
late = 'assigned-after-export';
export const { a: destructuredA, b: [destructuredB] = [] } = { a: 1, b: [2] };
