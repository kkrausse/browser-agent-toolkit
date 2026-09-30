import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";

test("actual classic-script lab bundle preserves native event globals without repair", async () => {
  const directory = await mkdtemp("/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/readiness-bundle-");
  const window = new Window({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  try {
    const built = Bun.spawnSync(["bun", "scripts/serve-chat-readiness-lab.ts", `--freeze=${directory}`], { cwd: resolve(import.meta.dir, "..") });
    expect(built.exitCode).toBe(0);
    const bytes = await Bun.file(resolve(directory, "lab.js")).text();
    const html = await Bun.file(resolve(directory, "index.html")).text();
    expect(html).toContain('<script src="/lab.js"></script>');
    expect(bytes).toContain("function addEventListener(");
    const nativeAdd = window.addEventListener, nativeRemove = window.removeEventListener;
    window.document.body.innerHTML = '<div id="root"></div>';
    // Execute the exact output, not a renamed helper or patched native global.
    window.eval(bytes);
    expect(window.addEventListener).toBe(nativeAdd);
    expect(window.removeEventListener).toBe(nativeRemove);
    let observed = false;
    window.addEventListener("native-preservation", () => { observed = true; });
    window.dispatchEvent(new window.Event("native-preservation"));
    expect(observed).toBe(true);
  } finally {
    await window.happyDOM.abort();
    window.close();
    await rm(directory, { recursive: true });
  }
});
