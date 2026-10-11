import { createFileRoute } from '@tanstack/react-router'
import { handleRpc } from '../../server/http'

// The Effect API: every procedure of the contract is a POST to this one route.
export const Route = createFileRoute('/api/rpc')({
  server: { handlers: { POST: ({ request }) => handleRpc(request) } },
})
