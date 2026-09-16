import { TRPCError } from '@trpc/server'
import * as v from 'valibot'
import { TodoSchema } from '@/schema/todo'
import { t } from '@/server/trpc'

export const appRouter = t.router({
  getTodos: t.procedure.query(({ ctx }) => [...ctx.todos.values()]),
  addTodo: t.procedure.input(v.pick(TodoSchema, ['title'])).mutation(({ ctx, input }) => {
    const todo = { id: crypto.randomUUID(), title: input.title, completed: false }
    ctx.todos.set(todo.id, todo)
    return todo
  }),
  setTodoCompleted: t.procedure.input(v.pick(TodoSchema, ['id', 'completed'])).mutation(({ ctx, input }) => {
    const todo = ctx.todos.get(input.id)
    if (!todo) throw new TRPCError({ code: 'NOT_FOUND', message: 'Todo not found' })
    const updated = { ...todo, completed: input.completed }
    ctx.todos.set(todo.id, updated)
    return updated
  }),
  deleteTodo: t.procedure.input(v.pick(TodoSchema, ['id'])).mutation(({ ctx, input }) => {
    if (!ctx.todos.delete(input.id)) throw new TRPCError({ code: 'NOT_FOUND', message: 'Todo not found' })
    return { id: input.id }
  }),
})

export type AppRouter = typeof appRouter
