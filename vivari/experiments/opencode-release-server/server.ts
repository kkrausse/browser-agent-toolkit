import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { ServerProcess } from '@opencode/server/process';

await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const server = yield* ServerProcess.start({
    app: { name: 'vivari-opencode-server', version: '2.0.3', channel: 'stable' },
    hostname: '127.0.0.1', port: 4096,
    password: process.env.OPENCODE_PASSWORD,
    database: { path: process.env.OPENCODE_DATABASE_PATH ?? '/runtime-probe/opencode.sqlite' },
    models: { fetch: false },
    config: { project: false, content: '{"snapshot":false}' },
    fs: { filewatcher: false, fff: false },
  }, {
    onListen: (_address, shutdown) => Effect.sync(() => {
      const stop = () => { void Effect.runPromise(shutdown); };
      process.stdin.once('end', stop);
      process.stdin.resume();
      return Effect.sync(() => { process.stdin.removeListener('end', stop); });
    }),
  });
  console.log('OPENCODE_SERVER_PROCESS_READY');
  yield* server.shutdown;
})).pipe(Effect.provide(NodeServices.layer)));
console.log('OPENCODE_SERVER_PROCESS_SHUTDOWN_COMPLETE');
