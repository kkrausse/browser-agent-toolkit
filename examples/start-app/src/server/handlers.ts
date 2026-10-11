// The server side of the contract: one handler per procedure, each an Effect over TodoRepo.
import { Effect, Layer } from 'effect'
import { TodoRpcs } from '../api/contract'
import { TodoRepo } from './todo-repo'

export const TodoHandlers = TodoRpcs.toLayer(
  Effect.gen(function* () {
    const todos = yield* TodoRepo
    return {
      ListTodos: () => todos.list,
      AddTodo: ({ title }) => todos.add(title),
      ToggleTodo: ({ id }) => todos.toggle(id),
      DeleteTodo: ({ id }) => todos.remove(id),
    }
  }),
).pipe(Layer.provide(TodoRepo.layer))
