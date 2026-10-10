// TypeScript from the overlay: transformed by the bat-modules Wasm at load, cached by content.
import { greet, type Greeting } from './ts-lib'
import { Kind } from './ts-lib.js'

interface Options { name: string; times?: number }
enum Level { Low = 1, High }
class Box<T> {
  constructor(private readonly value: T) {}
  get(): T { return this.value }
}
const opts: Options = { name: 'bat' }
const g: Greeting = greet(opts.name)
const box = new Box<number>(Level.High as number)
console.log(g.text, box.get(), Kind.A, (opts.times ?? 3) satisfies number)
const answer = await Promise.resolve(42 as const)
console.log('tla in ts', answer)
