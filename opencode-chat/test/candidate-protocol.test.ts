import { expect, test } from "bun:test";
import { Cause, Effect, ManagedRuntime } from "effect";
import { OpenCodeAPI } from "../src/api";
import { questionFromForm } from "../src/forms";
import { fixture, deferred, json, tick } from "./fixture";
import type { FormInfo } from "../src/vendor/types";

test("candidate catalog waits for location plugin activation before reading models", async () => {
  const f = fixture();
  const activation = deferred<Response>();
  f.override = url => url.pathname.endsWith("/await-activation") ? activation.promise : undefined;
  const runtime = ManagedRuntime.make(OpenCodeAPI.layer(f.endpoint, "/caller dir"));
  const models = Effect.gen(function*() { return yield* (yield* OpenCodeAPI).models(); });
  const pending = runtime.runPromise(models);
  await tick();
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.init.method).toBe("POST");
  expect(f.calls[0]!.url.searchParams.get("location[directory]")).toBe("/caller dir");
  activation.resolve(new Response(null, { status: 204 }));
  expect(await pending).toHaveLength(1);
  expect(f.calls[1]!.url.pathname).toBe("/proxy/api/model");
  f.override = url => url.pathname.endsWith("/await-activation") ? json({}, 503) : undefined;
  await expect(runtime.runPromise(models.pipe(Effect.catchCause(cause => Effect.fail(new Error(Cause.pretty(cause))))))).rejects.toThrow("503");
  expect(f.calls).toHaveLength(3);
  await runtime.dispose();
});

test("question adapter refuses to silently drop form constraints or remap option values", () => {
  const form: FormInfo = { id: "f", sessionID: "s", title: "Questions", metadata: { kind: "question" },
    fields: [{ key: "q0", type: "string", options: [{ value: "A", label: "A" }], custom: true }] };
  expect(questionFromForm(form)?.questions).toHaveLength(1);
  for (const field of [
    { ...form.fields[0], when: [{ key: "other", op: "eq", value: "A" }] },
    { ...form.fields[0], minLength: 4 },
    { ...form.fields[0], required: false },
    { ...form.fields[0], options: [{ value: "internal", label: "A" }] },
    { ...form.fields[0], type: "external", url: "https://example.com" },
  ]) expect(questionFromForm({ ...form, fields: [field] } as FormInfo)).toBeUndefined();
  expect(questionFromForm({ ...form, metadata: {} })).toBeUndefined();
});
