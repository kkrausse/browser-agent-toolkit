// QA adapter only. These imports are resolved to frozen candidate files by the builder.
import { deferred, fixture, json, location, model } from "../test/fixture";
import { createChatController } from "../src/controller";

export const fixtureInputs = {
  directory: "/hidden", sessionID: "ses1", method: "POST",
  modelPath: "/proxy/api/session/ses1/model",
  models: [{ providerID: "p", id: "m" }, { providerID: "p", id: "m2" }],
  response: "release: HTTP 204; reject: injected transport Error",
} as const;

export function createCase(name: string, notify: () => void) {
  const f = fixture();
  let gate: ReturnType<typeof deferred<Response>> | undefined;
  const counters = { holds: 0, releases: 0, rejects: 0, unexpectedModelWrites: 0 };
  let heldBody: unknown;
  let ready = false;
  let readyError: string | undefined;
  f.override = (url, init) => {
    queueMicrotask(notify);
    if (url.pathname === "/proxy/api/model" && (!init.method || init.method === "GET"))
      return json({ location, data: [model, { ...model, id: "m2", modelID: "m2", name: "QA Model Two" }] });
    // Never intercept plugin/await-activation, prompt, creation, or other writes.
    if (url.pathname === fixtureInputs.modelPath && init.method === fixtureInputs.method) {
      let body: unknown;
      try { body = JSON.parse(String(init.body)); } catch { /* reject malformed fixture input below */ }
      const value = body as { model?: { id?: string; providerID?: string } } | undefined;
      const valid = value && Object.keys(value).length === 1 && value.model &&
        Object.keys(value.model).length === 2 && value.model.providerID === "p" &&
        (value.model.id === "m" || value.model.id === "m2");
      if (!valid || gate) {
        counters.unexpectedModelWrites++;
        return Promise.reject(new Error("QA unexpected model request or concurrent hold"));
      }
      counters.holds++;
      heldBody = body;
      gate = deferred<Response>();
      return gate.promise;
    }
  };
  const controller = createChatController({ endpoint: f.endpoint, directory: fixtureInputs.directory });
  void controller.ready.then(() => { ready = true; notify(); }, error => {
    readyError = String(error); notify();
  });
  return {
    name, f, controller,
    status: () => ({ ready, readyError, held: !!gate, heldBody, ...counters,
      promptCount: f.calls.filter(call => call.url.pathname.endsWith("/prompt")).length }),
    release: () => {
      if (!gate) throw new Error("QA no held model operation");
      const pending = gate; gate = undefined; counters.releases++;
      pending.resolve(new Response(null, { status: 204 })); notify();
    },
    reject: () => {
      if (!gate) throw new Error("QA no held model operation");
      const pending = gate; gate = undefined; counters.rejects++;
      pending.reject(new Error("QA injected model transport rejection")); notify();
    },
  };
}
