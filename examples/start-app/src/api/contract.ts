// The API contract: every procedure with its payload, success and error schemas. The server
// implements it (../server/handlers.ts) and the client is derived from it (./client.ts),
// so both sides share these types and nothing is declared twice.
import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

export const Todo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  completed: Schema.Boolean,
})
export type Todo = typeof Todo.Type

export const Title = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(200))

export class TodoNotFound extends Schema.TaggedError<TodoNotFound>()('TodoNotFound', {
  id: Schema.String,
}) {}

export class TodoRpcs extends RpcGroup.make(
  Rpc.make('ListTodos', { success: Schema.Array(Todo) }),
  Rpc.make('AddTodo', { payload: { title: Title }, success: Todo }),
  Rpc.make('ToggleTodo', { payload: { id: Schema.String }, success: Todo, error: TodoNotFound }),
  Rpc.make('DeleteTodo', { payload: { id: Schema.String }, error: TodoNotFound }),
) {}
