import { tests } from "./cases.js";
import { drainLogs, log } from "./harness.js";

const api = {
  cases: tests.map(({ name, steps }) => ({ name, steps: steps.length })),
  async run(index: number, step: number) {
    const test = tests[index];
    if (!test?.steps[step]) throw new Error("Unknown test step");
    log("start", { name: test.name, step });
    try {
      await test.steps[step]();
      log("pass", { name: test.name, step });
      await drainLogs();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      log("fail", message);
      await drainLogs();
      return { ok: false, error: message };
    }
  },
};
declare global { interface Window { browserTests: typeof api } }
window.browserTests = api;
document.body.textContent = "Workspace browser contracts — ready";
