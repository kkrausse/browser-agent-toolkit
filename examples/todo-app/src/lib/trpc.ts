import { createTRPCReact } from '@trpc/react-query'
import { createTRPCContext } from '@trpc/tanstack-react-query'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@/server/trpcRouter'

export const trpc = createTRPCReact<AppRouter>()
export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>()
export type RouterOutputs = inferRouterOutputs<AppRouter>

export const trpcClient = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: '/api' })],
})
