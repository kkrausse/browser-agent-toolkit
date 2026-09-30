// Narrow regression for the observed QA gate swallowing boot activation.
// Run in an isolated staging directory whose src/test links point to frozen candidate files.
import { expect, test } from "bun:test";
import { createCase } from "./controller-swap-repaired-fixture";

test("QA gate permits activation and holds only explicit ses1 model writes", async () => {
  const item = createCase("offline-regression", () => {});
  try {
    await item.controller.ready;
    expect(item.status().ready).toBe(true);
    expect(item.status().holds).toBe(0);
    expect(item.f.calls.some(call => call.url.pathname === "/proxy/api/plugin/await-activation")).toBe(true);
    expect(item.controller.getSnapshot().sessionID).toBe("ses1");
    expect(item.controller.getSnapshot().models.map(model => model.id)).toEqual(["m", "m2"]);
    const waitForHold = async (count: number) => {
      for (let attempt = 0; attempt < 100 && item.status().holds !== count; attempt++)
        await Bun.sleep(5);
      expect(item.status().holds).toBe(count);
      expect(item.controller.getSnapshot().sessionOperationPending).toBe(true);
    };
    const first = item.controller.selectModel({ providerID: "p", id: "m2" });
    await waitForHold(1);
    expect(item.status().heldBody).toEqual({ model: { providerID: "p", id: "m2" } });
    await expect(item.controller.send({ text: "must-not-queue" })).rejects.toThrow();
    await expect(item.controller.selectModel({ providerID: "p", id: "m" })).rejects.toThrow();
    expect(item.status().holds).toBe(1);
    item.release(); await first;
    expect(item.status().releases).toBe(1);
    expect(item.controller.getSnapshot().sessionOperationPending).toBe(false);
    expect(item.status().promptCount).toBe(0);
    const second = item.controller.selectModel({ providerID: "p", id: "m" });
    // Attach the rejection handler before intentionally rejecting the fixture promise.
    const rejected = second.then(() => false, () => true);
    await waitForHold(2);
    item.reject(); expect(await rejected).toBe(true);
    expect(item.status().rejects).toBe(1);
    expect(item.status().unexpectedModelWrites).toBe(0);
    expect(item.controller.getSnapshot().sessionOperationPending).toBe(false);
    expect(item.status().promptCount).toBe(0);
  } finally { await item.controller.dispose(); }
}, 5000);
