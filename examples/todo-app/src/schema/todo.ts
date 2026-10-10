import * as v from 'valibot'

export const TodoSchema = v.object({
  id: v.string(),
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  completed: v.boolean(),
})
export type Todo = v.InferInput<typeof TodoSchema>
