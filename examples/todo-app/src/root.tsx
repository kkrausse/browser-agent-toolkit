import type { ReactNode } from 'react'
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { trpc, trpcClient, TRPCProvider } from '@/lib/trpc'
import '@/style.css'
import cssUrl from '@/style.css?url'
import Editing from '@/editing'

const queryClient = new QueryClient()

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Todos</title>
        <link rel="preload" href={cssUrl} as="style" />
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
