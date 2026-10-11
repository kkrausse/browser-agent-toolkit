// The contract served over HTTP, as one function from a Request to a Response. The route
// `src/routes/api/rpc.ts` hands it every request, so the API is part of the app's own server.
import { Layer } from 'effect'
import { HttpRouter } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { TodoRpcs } from '../api/contract'
import { TodoHandlers } from './handlers'

// The route decided that the request is for the API; whatever its path, it is answered here.
const Api = RpcServer.layerHttp({ group: TodoRpcs, path: '*', protocol: 'http' }).pipe(
  Layer.provide(TodoHandlers),
  Layer.provide(RpcSerialization.layerNdjson),
)

const { handler, dispose } = HttpRouter.toWebHandler(Api, { disableLogger: true })

export const handleRpc = (request: Request): Promise<Response> => handler(request)

// An edit to a handler loads this module again: close the database of the old one.
import.meta.hot?.dispose(() => dispose())
