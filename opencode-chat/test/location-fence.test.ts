import { expect, test } from "bun:test";
import { Deferred, Duration, Effect, Exit, Fiber, RcMap, Scope } from "effect";

// Matching dependency contract, not a packaged OpenCode tool/session integration.
test("join old reader/tool settlement then evict joins finalization before same-key acquisition", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const toolStopping = yield* Deferred.make<void>();
    const toolSettled = yield* Deferred.make<void>();
    const finalizing = yield* Deferred.make<void>();
    const finalized = yield* Deferred.make<void>();
    const receipts: string[] = [];
    let builds = 0;
    const map = yield* RcMap.make({ idleTimeToLive: Duration.infinity,
      lookup: () => Effect.acquireRelease(Effect.sync(() => {
        receipts.push(`build:${++builds}`);
        return builds;
      }), id => id === 1 ? Effect.gen(function*() {
        receipts.push("finalize:1:start");
        yield* Deferred.succeed(finalizing, undefined);
        yield* Deferred.await(finalized);
        receipts.push("finalize:1:end");
      }) : Effect.sync(() => { receipts.push(`finalize:${id}:end`); })),
    });
    const oldReader = yield* Scope.make();
    yield* RcMap.get(map, "/workspace").pipe(Scope.provide(oldReader));
    // Controlled non-model work has an asynchronous interruption finalizer.
    yield* Effect.never.pipe(Effect.ensuring(Effect.gen(function*() {
      yield* Deferred.succeed(toolStopping, undefined);
      yield* Deferred.await(toolSettled);
      receipts.push("tool:settled");
    })), Effect.forkIn(oldReader, { startImmediately: true }));
    const switchTask = yield* Effect.gen(function*() {
      yield* Scope.close(oldReader, Exit.void);
      receipts.push("readers:joined");
      yield* RcMap.invalidate(map, "/workspace");
      receipts.push("evict:joined");
      const incoming = yield* Scope.make();
      const id = yield* RcMap.get(map, "/workspace").pipe(Scope.provide(incoming));
      expect(id).toBe(2);
      yield* Scope.close(incoming, Exit.void);
      yield* RcMap.invalidate(map, "/workspace");
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(toolStopping);
    expect(receipts).toEqual(["build:1"]);
    expect(yield* RcMap.has(map, "/workspace")).toBe(true);
    yield* Deferred.succeed(toolSettled, undefined);
    yield* Deferred.await(finalizing);
    expect(receipts).toEqual(["build:1", "tool:settled", "readers:joined", "finalize:1:start"]);
    expect(builds).toBe(1);
    yield* Deferred.succeed(finalized, undefined);
    yield* Fiber.join(switchTask);
    expect(receipts).toEqual(["build:1", "tool:settled", "readers:joined", "finalize:1:start",
      "finalize:1:end", "evict:joined", "build:2", "finalize:2:end"]);
  })));
});

test("a failed old-reader finalizer fails closed without invalidation or replacement", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    let builds = 0;
    const map = yield* RcMap.make({ idleTimeToLive: Duration.infinity,
      lookup: () => Effect.sync(() => ++builds) });
    const oldReader = yield* Scope.make();
    yield* RcMap.get(map, "/workspace").pipe(Scope.provide(oldReader));
    yield* Scope.addFinalizer(oldReader, Effect.die("controlled old-reader finalization failure"));
    const result = yield* Effect.gen(function*() {
      yield* Scope.close(oldReader, Exit.void);
      yield* RcMap.invalidate(map, "/workspace");
      yield* RcMap.get(map, "/workspace");
    }).pipe(Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    expect(builds).toBe(1);
    expect(yield* RcMap.has(map, "/workspace")).toBe(true);
  })));
});
