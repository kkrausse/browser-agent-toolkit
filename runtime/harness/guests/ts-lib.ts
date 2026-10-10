export interface Greeting { text: string }
export const enum Kind { A = 'a', B = 'b' }
export function greet(name: string): Greeting {
  return { text: `hello ${name}` }
}
