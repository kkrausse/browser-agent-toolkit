// No await here, but a dependency has one: this module must wait for it.
import { length } from './tla.mjs';
export const doubled = length * 2;
