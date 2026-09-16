import { Runtime, Workspace, opfsStore } from "../../src/index.js";
import type { RipgrepTool } from "../../src/index.js";

// Dependencies are prepared separately; opening launches no project applications.

export async function runBasic(opts: {
  workspaceId: string;
  distribution: { name: string; version: string; assetBaseUrl: string };
  ripgrep: RipgrepTool;
}) {
  const workspace = await Workspace.open({
    id: opts.workspaceId,
    storage: opfsStore(opts.distribution),
  });
  await workspace.fs.writeFile("/src/App.tsx", "export default {}");
  const runtime = await Runtime.start({
    distribution: opts.distribution,
    workspace,
    tools: { ripgrep: opts.ripgrep },
  });
  const matches = await runtime.tools.ripgrep({
    pattern: "TODO",
    paths: ["/workspace/src"],
  });
  const vite = await runtime.node({
    entry: "/workspace/node_modules/vite/bin/vite.js",
    args: ["--port", "5173", "--strictPort"],
    cwd: "/workspace",
    env: {},
  });
  const drain = async (stream: AsyncIterable<Uint8Array>) => { for await (const _chunk of stream) { /* application logging */ } };
  const output = Promise.all([drain(vite.stdout), drain(vite.stderr)]);
  const endpoint = await runtime.expose(5173);
  void matches;
  await vite.stop();
  await output;
  endpoint.dispose();
  await runtime.stop();
  await workspace.flush();
  await workspace.close();
}
