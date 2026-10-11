import type { ReactNode } from 'react'
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { trpc, trpcClient, TRPCProvider } from '@/lib/trpc'
import '@/style.css'
import Editing from '@/editing'

// One client for the life of the page. A hot update of this module must not replace it: the
// mounted queries would stay on the old one.
const queryClient: QueryClient = import.meta.hot?.data.queryClient ?? new QueryClient()
if (import.meta.hot) import.meta.hot.data.queryClient = queryClient

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Todos</title>
        {/* No <link> to the stylesheet here. The import above is enough (styles injected in
            development, a stylesheet from <Links /> in a build), and Vite's CSS hot update
            swaps any <link> whose href names the edited file for a clone: React is left
            holding a detached node, and the next edit that makes it remove that node (a
            line added to this <head>) throws in the commit, after which nothing in the app
            updates again. */}
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}

export default function Root() {
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <trpc.Provider client={trpcClient} queryClient={queryClient}>
          <Outlet />
          <Editing />
        </trpc.Provider>
      </TRPCProvider>
    </QueryClientProvider>
  )
}
