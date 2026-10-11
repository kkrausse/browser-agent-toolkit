// The client side of the contract, derived from it: `api(client => client.ToggleTodo({ id }))`
// runs one call and resolves to its typed result, a `Success` with the declared value or a
// `Failure` with one of the declared errors (or `RpcClientError`, when the call never arrived).
import { createIsomorphicFn } from '@tanstack/react-start'
import { Effect, Layer, ManagedRuntime, type Result } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { RpcClient, type RpcClientError, type RpcGroup, RpcSerialization } from 'effect/rpc'
import { handleRpc } from '../server/http'
import { TodoRpcs } from './contract'

export type TodoClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof TodoRpcs>, RpcClientError.RpcClientError>

// In the browser a call is a POST to the app's own `/api/rpc`. While the server renders a
// page there is no need for the network: the same request goes straight to the handler.
// (Start keeps the `.server` half, and what only it imports, out of the browser's bundle.)
const transport = createIsomorphicFn()
  .client(() => FetchHttpClient.layer)
  .server(() => FetchHttpClient.layer.pipe(
    // A `fetch` that calls the handler. (`typeof fetch` has more than the call in some runtimes; `fetch` supplies the rest.)
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(Object.assign((input: RequestInfo | URL, init?: RequestInit) => handleRpc(new Request(input, init)), fetch))),
  ))
const url = createIsomorphicFn()
  .client(() => `${import.meta.env.BASE_URL}api/rpc`)
  .server(() => 'http://server.internal/api/rpc')

const runtime = ManagedRuntime.make(
  RpcClient.layerProtocolHttp({ url: url() }).pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(transport()),
  ),
)

export const api = <A, E>(call: (client: TodoClient) => Effect.Effect<A, E>): Promise<Result.Result<A, E>> =>
  runtime.runPromise(Effect.scoped(Effect.flatMap(RpcClient.make(TodoRpcs), call)).pipe(Effect.result))
