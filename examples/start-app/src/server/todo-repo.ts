// Todos in the database. The only module that knows the table.
import { Context, Effect, Layer, Schema } from 'effect'
import { Todo, TodoNotFound } from '../api/contract'
import { Database } from './database'

// A row as SQLite returns it: `completed` is 0 or 1.
const Row = Schema.Struct({ id: Schema.String, title: Schema.String, completed: Schema.Literals([0, 1]) })
const decodeRows = Schema.decodeUnknownSync(Schema.Array(Row))
const toTodo = (row: typeof Row.Type): Todo => ({ id: row.id, title: row.title, completed: row.completed === 1 })

export class TodoRepo extends Context.Service<TodoRepo, {
  readonly list: Effect.Effect<ReadonlyArray<Todo>>
  add(title: string): Effect.Effect<Todo>
  toggle(id: string): Effect.Effect<Todo, TodoNotFound>
  remove(id: string): Effect.Effect<void, TodoNotFound>
}>()('start-app/TodoRepo') {
  static readonly layer = Layer.effect(
    TodoRepo,
    Effect.gen(function* () {
      const database = yield* Database
      const select = database.prepare('SELECT id, title, completed FROM todos ORDER BY created, rowid')
      const selectOne = database.prepare('SELECT id, title, completed FROM todos WHERE id = ?')
      const insert = database.prepare('INSERT INTO todos (id, title, created) VALUES (?, ?, ?)')
      const flip = database.prepare('UPDATE todos SET completed = 1 - completed WHERE id = ?')
      const erase = database.prepare('DELETE FROM todos WHERE id = ?')

      const list = Effect.sync(() => decodeRows(select.all()).map(toTodo))

      const add = (title: string) => Effect.sync(() => {
        const todo: Todo = { id: crypto.randomUUID(), title, completed: false }
        insert.run(todo.id, todo.title, Date.now())
        return todo
      })

      const toggle = Effect.fn('TodoRepo.toggle')(function* (id: string) {
        if (flip.run(id).changes === 0) return yield* new TodoNotFound({ id })
        return toTodo(decodeRows(selectOne.all(id))[0]!)
      })

      const remove = Effect.fn('TodoRepo.remove')(function* (id: string) {
        if (erase.run(id).changes === 0) return yield* new TodoNotFound({ id })
      })

      return TodoRepo.of({ list, add, toggle, remove })
    }),
  ).pipe(Layer.provide(Database.layer))
}
