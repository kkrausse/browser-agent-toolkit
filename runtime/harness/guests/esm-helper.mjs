import { back } from './esm-cycle.mjs'
export let counter = 0
export function bump() { counter++ }
export function fromHelper() { return 'helper' }
export const cycleValue = () => back()
export default 'helper-default'
