import { expect, test } from "bun:test"
import { EnvironmentOwnershipError, experimentalInstalledEnvironmentAuditTool, experimentalSourceReplacementTool, reusableEnvironmentExperiment } from "../src/environment-experiment"
import type { Execution, ToolContext } from "../src/types"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const exit = { exitCode: 0, signal: null, forced: false }
const output = (text = '{"valid":false,"checked":0,"reason":"invalid fixture"}') => (async function* () { yield new TextEncoder().encode(text) })()
function fixture(first: (signal: AbortSignal) => Promise<Execution> | Execution) {
  let launches = 0, deliveries = 0
  const context: ToolContext = {
    readFile: async () => new TextEncoder().encode("key"), installFile: async () => {},
    installTree: async () => { throw Error("unused") },
    node: async options => ++launches === 1 ? first(options.signal!) : execution(),
  }
  const delivery = { name: "fixture", version: "1", bind: async () => async () => { deliveries++ } }
  return { context, delivery, deliveries: () => deliveries, launches: () => launches }
}
function execution(overrides: Partial<Execution> = {}): Execution {
  return { stdout: output(), stderr: output(""), exited: Promise.resolve(exit), closeStdin() {}, writeStdin() {}, stop: async () => {}, ...overrides }
}
async function reuse(f: ReturnType<typeof fixture>, signal?: AbortSignal) {
  return reusableEnvironmentExperiment({ key: "key", entries: [], roots: ["/workspace/node_modules"], report() {}, delivery: f.delivery, signal }).bind(f.context)
}

test("proven miss joins stdout, stderr, exit AND stop before receipt/fallback", async () => {
  const stdout = deferred<void>(), stderr = deferred<void>(), exited = deferred<typeof exit>(), stop = deferred<void>(), startedStop = deferred<void>(), launched = deferred<void>()
  const f = fixture(() => { launched.resolve(); return execution({
    stdout: (async function* () { await stdout.promise; yield new TextEncoder().encode('{"valid":false}') })(),
    stderr: (async function* () { await stderr.promise })(), exited: exited.promise,
    stop: () => { startedStop.resolve(); return stop.promise },
  }) })
  const running = (await reuse(f))()
  await launched.promise
  stdout.resolve(); stderr.resolve(); await Promise.resolve()
  expect(f.launches()).toBe(1); expect(f.deliveries()).toBe(0)
  exited.resolve(exit); await startedStop.promise
  expect(f.launches()).toBe(1); expect(f.deliveries()).toBe(0)
  stop.resolve(); await running
  expect(f.launches()).toBe(3); expect(f.deliveries()).toBe(1)
})

for (const failure of ["stdout", "stderr", "exit", "stop", "close", "launch"] as const) {
  test(`${failure} failure rejects ownership and forbids receipt/fallback`, async () => {
    const held = deferred<void>(), stopStarted = deferred<void>()
    const broken = () => (async function* () { throw Error(`${failure} injected`) })()
    const f = fixture(() => {
      if (failure === "launch") throw Error("launch injected")
      return execution({
        stdout: failure === "stdout" ? broken() : failure === "stderr" ? (async function* () { await held.promise; yield new TextEncoder().encode('{"valid":false}') })() : output(),
        stderr: failure === "stderr" ? broken() : (async function* () { await held.promise })(),
        exited: failure === "exit" ? Promise.reject(Error("exit injected")) : Promise.resolve(exit),
        closeStdin() { if (failure === "close") throw Error("close injected") },
        stop: async () => { stopStarted.resolve(); if (failure === "stop") throw Error("stop injected") },
      })
    })
    let done = false
    const running = (await reuse(f))().finally(() => { done = true })
    const outcome = running.then(() => null, error => error)
    if (["stdout", "stderr", "exit", "close"].includes(failure)) {
      await stopStarted.promise
      expect(done).toBe(false); expect(f.deliveries()).toBe(0)
    }
    held.resolve(); expect(await outcome).toBeInstanceOf(EnvironmentOwnershipError)
    expect(f.deliveries()).toBe(0); expect(f.launches()).toBe(1)
  })
}

test("consumer abort requests stop promptly, joins held reader and exit, never falls back", async () => {
  const controller = new AbortController(), held = deferred<void>(), exited = deferred<typeof exit>(), stopStarted = deferred<void>(), launched = deferred<void>()
  const f = fixture(signal => {
    expect(signal).not.toBe(controller.signal)
    launched.resolve()
    return execution({ stderr: (async function* () { await held.promise })(), exited: exited.promise, stop: async () => { stopStarted.resolve() } })
  })
  let done = false
  const running = (await reuse(f, controller.signal))().finally(() => { done = true })
  const outcome = running.then(() => null, error => error)
  await launched.promise; controller.abort(Error("consumer canceled")); await stopStarted.promise
  expect(done).toBe(false); expect(f.deliveries()).toBe(0)
  held.resolve(); await Promise.resolve(); expect(done).toBe(false)
  exited.resolve(exit); expect(await outcome).toHaveProperty("message", "consumer canceled")
  expect(f.launches()).toBe(1)
})

test("nonzero guest exit permits conservative fallback only after proven cleanup", async () => {
  let stopped = false
  const f = fixture(() => execution({ exited: Promise.resolve({ ...exit, exitCode: 1 }), stop: async () => { stopped = true } }))
  const run = await reusableEnvironmentExperiment({ key: "key", entries: [], roots: ["/workspace/node_modules"], report() {},
    delivery: { ...f.delivery, bind: async () => async () => { expect(stopped).toBe(true); await (await f.delivery.bind())() } },
  }).bind(f.context)
  await run(); expect(f.deliveries()).toBe(1)
})

test("public stopped audit refuses missing stopped-services attestation before launch", async () => {
  const f = fixture(() => execution())
  const audit = await experimentalInstalledEnvironmentAuditTool([], ["/workspace/node_modules"], { paths: [] }).bind(f.context)
  await expect(audit({ servicesStopped: false } as never)).rejects.toThrow("Stopped services required")
  expect(f.launches()).toBe(0)
})

test("public stopped audit rejects malformed successful results after stop", async () => {
  let stopped = false
  const f = fixture(() => execution({ stdout: output('{"valid":true}'), stop: async () => { stopped = true } }))
  const audit = await experimentalInstalledEnvironmentAuditTool([], ["/workspace/node_modules"], { paths: [] }).bind(f.context)
  await expect(audit({ servicesStopped: true })).rejects.toThrow("Invalid installed audit result")
  expect(stopped).toBe(true)
})

test("bounded output overflow cancels and rejects instead of falling back", async () => {
  let stopped = false, canceled = false
  const f = fixture(signal => {
    signal.addEventListener("abort", () => { canceled = true })
    return execution({ stdout: (async function* () { yield new Uint8Array(4 * 1024 * 1024 + 1) })(), stop: async () => { stopped = true } })
  })
  await expect((await reuse(f))()).rejects.toBeInstanceOf(EnvironmentOwnershipError)
  expect(stopped).toBe(true); expect(canceled).toBe(true); expect(f.deliveries()).toBe(0)
})

test("cache cleanup scope is frozen at validation; a cleanup failure forbids delivery", async () => {
  for (const failCleanup of [false, true]) {
    const policy = { paths: ["/workspace/.browser-editor-cache/vite"] }, scripts: string[] = []
    let launches = 0, stopped = 0
    const f = fixture(() => execution())
    f.context.installFile = async (_path, bytes) => { scripts.push(new TextDecoder().decode(bytes)) }
    f.context.node = async () => execution({
      stdout: output('{"valid":false,"checked":0,"reason":"fixture miss"}'),
      exited: Promise.resolve({ ...exit, exitCode: ++launches === 3 && failCleanup ? 1 : 0 }),
      stop: async () => { stopped++ },
    })
    const tool = reusableEnvironmentExperiment({ key: "key", entries: [], roots: ["/workspace/node_modules"], report() {}, delivery: f.delivery, preserveCaches: { servicesStopped: true, policy } })
    policy.paths[0] = "/workspace/source-must-not-be-deleted"
    const run = await tool.bind(f.context)
    if (failCleanup) await expect(run()).rejects.toThrow("process failed")
    else await run()
    expect(scripts[2]).toContain("/workspace/.browser-editor-cache/vite")
    expect(scripts[2]).not.toContain("source-must-not-be-deleted")
    expect(stopped).toBe(launches)
    expect(f.deliveries()).toBe(failCleanup ? 0 : 1)
  }
})

test("synchronously throwing launch also forbids fallback without an Execution witness", async () => {
  const f = fixture(() => execution())
  f.context.node = () => { throw Error("synchronous launch failure") }
  await expect((await reuse(f))()).rejects.toBeInstanceOf(EnvironmentOwnershipError)
  expect(f.deliveries()).toBe(0)
})

test("throwing output getter still starts stop and joins other execution channels", async () => {
  const held = deferred<void>(), stopStarted = deferred<void>()
  const f = fixture(() => {
    const value = execution({ stderr: (async function* () { await held.promise })(), stop: async () => { stopStarted.resolve() } })
    return Object.defineProperty(value, "stdout", { get() { throw Error("stdout getter failure") } })
  })
  let done = false
  const running = (await reuse(f))().finally(() => { done = true })
  const outcome = running.then(() => null, error => error)
  await stopStarted.promise
  expect(done).toBe(false); expect(f.deliveries()).toBe(0)
  held.resolve(); expect(await outcome).toBeInstanceOf(EnvironmentOwnershipError)
  expect(f.deliveries()).toBe(0)
})

test("abort plus failed stop reports unproven ownership", async () => {
  const controller = new AbortController(), launched = deferred<void>()
  const f = fixture(() => { launched.resolve(); return execution({ stop: async () => { throw Error("cancel stop failed") } }) })
  const running = (await reuse(f, controller.signal))()
  const outcome = running.then(() => null, error => error)
  await launched.promise; controller.abort(); expect(await outcome).toBeInstanceOf(EnvironmentOwnershipError)
  expect(f.deliveries()).toBe(0)
})

test("source replacement and public audit forward consumer cancellation and join", async () => {
  for (const kind of ["source", "audit"] as const) {
    const controller = new AbortController(), launched = deferred<void>(), held = deferred<void>(), stopStarted = deferred<void>()
    const f = fixture(() => { launched.resolve(); return execution({ stdout: (async function* () { await held.promise })(), stop: async () => { stopStarted.resolve() } }) })
    const run = kind === "source"
      ? await experimentalSourceReplacementTool({}, { signal: controller.signal }).bind(f.context)
      : await experimentalInstalledEnvironmentAuditTool([], ["/workspace/node_modules"], { paths: [] }).bind(f.context)
    let done = false
    const running = (kind === "source" ? (run as (options: void) => Promise<unknown>)() : (run as (options: { servicesStopped: true; signal: AbortSignal }) => Promise<unknown>)({ servicesStopped: true, signal: controller.signal })).finally(() => { done = true })
    const outcome = running.then(() => null, error => error)
    await launched.promise; controller.abort(Error("cancel tool")); await stopStarted.promise
    expect(done).toBe(false); held.resolve(); expect(await outcome).toHaveProperty("message", "cancel tool")
  }
})

test("pre-canceled reuse starts no execution or fallback", async () => {
  const f = fixture(() => execution()), signal = AbortSignal.abort(Error("pre-canceled"))
  await expect((await reuse(f, signal))()).rejects.toThrow("pre-canceled")
  expect(f.launches()).toBe(0); expect(f.deliveries()).toBe(0)
})
