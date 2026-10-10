import { initTRPC } from '@trpc/server'
import type { Todo } from '@/schema/todo'

export const t = initTRPC.context<{ req: Request; todos: Map<string, Todo> }>().create()
