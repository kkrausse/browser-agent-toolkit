import { Runtime } from "../src/index.js";
import type { RipgrepTool } from "../src/index.js";
import { defineRipgrepTool } from "../src/index.js";

declare const ripgrep: RipgrepTool;

async function configured() {
  const runtime = await Runtime.start({
    distribution: { name: "vivari", version: "test", assetBaseUrl: "/assets" },
    workspace: null as never,
    tools: { ripgrep },
  });
  // Configured tool resolves to the typed descriptor.
  const ok: Promise<{ matches: unknown[]; truncated: boolean }> =
    runtime.tools.ripgrep({ pattern: "x", paths: ["/workspace"] });
  void ok;
}

async function missing() {
  const runtime = await Runtime.start({
    distribution: { name: "vivari", version: "test", assetBaseUrl: "/assets" },
    workspace: null as never,
    tools: {},
  });
  // @ts-expect-error - ripgrep not configured: must not typecheck
  await runtime.tools.ripgrep({ pattern: "x", paths: ["/workspace"] });
}

async function wrongShape() {
  const bad = defineRipgrepTool({ name: "ripgrep", version: "1", receiptUrl: "/rg/rg-receipt.json" });
  void bad;
  const notATool = { nope: true };
  await Runtime.start({
    distribution: { name: "vivari", version: "test", assetBaseUrl: "/assets" },
    workspace: null as never,
    // @ts-expect-error - tools map requires ToolDescriptor entries
    tools: { ripgrep: notATool },
  });
}

void configured;
void missing;
void wrongShape;
