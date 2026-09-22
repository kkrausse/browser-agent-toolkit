import { describe, expect, test } from "bun:test";

import { diagnoseWorkspace, workspaceInternals, type Workspace } from "../src/workspace.js";
import type { Host } from "../src/host.js";

describe("workspace diagnostics", () => {
  test("returns the kernel's read-only diagnostic snapshot", async () => {
    const snapshot = {
      now: 123,
      procs: [{ pid: 2, ppid: 1, command: "rg landing .", cwd: "/workspace", sinceOutputMs: 5, sinceSyscallMs: 2, syscalls: 9, workerErrors: 0, booted: true, paused: false }],
      fetch: { inflight: 0, queued: 0, active: 0, cachedEntries: 1, cachedBytes: 20, pinnedBodies: 0 },
      listeners: [4096],
      pendingHttp: 0,
    };
    const workspace = {} as Workspace;
    const request = async (type: string) => {
      expect(type).toBe("vv-diag");
      return { type: "vv-reply", ok: true, diag: snapshot };
    };
    workspaceInternals.set(workspace, {
      host: { request } as unknown as Host,
      distribution: { name: "vivari", version: "test", assetBaseUrl: "/runtime/" },
      attached: true,
      clearing: false,
      closed: false,
    });

    expect(await diagnoseWorkspace(workspace)).toEqual(snapshot);
  });

  test("rejects a closed or unknown workspace", async () => {
    await expect(diagnoseWorkspace({} as Workspace)).rejects.toMatchObject({ code: "CLOSED" });
  });
});
