// The SQLite database, as a service: one connection for the life of the layer.
import { Context, Effect, Layer } from 'effect'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// A file in the project directory, so the list survives a restart of the dev server.
const file = resolve(process.env.TODO_DATABASE ?? 'data/todos.sqlite')

export class Database extends Context.Service<Database, DatabaseSync>()('start-app/Database') {
  static readonly layer = Layer.effect(
    Database,
    Effect.acquireRelease(
      Effect.sync(() => {
        mkdirSync(dirname(file), { recursive: true })
        const database = new DatabaseSync(file)
        database.exec('CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)')
        return database
      }),
      database => Effect.sync(() => database.close()),
    ),
  )
}
