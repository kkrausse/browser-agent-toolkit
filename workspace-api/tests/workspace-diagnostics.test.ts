import { describe, expect, test } from "bun:test";

import { diagnoseWorkspace, diagnoseWorkspaceEntry, workspaceInternals, type Workspace } from "../src/workspace.js";
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
    await expect(diagnoseWorkspaceEntry({} as Workspace, '/file')).rejects.toMatchObject({ code: "CLOSED" });
  });

  test('entry diagnostics only use lstat/readlink and preserve exact path bytes', async () => {
    const calls: unknown[] = [];
    const workspace = {} as Workspace;
    workspaceInternals.set(workspace, {host: {request: async (type: string, data: unknown) => {
      calls.push({type, data});
      return {result: calls.length === 1 ? {kind: 'symlink'} : '../missing\nfile'};
    }} as unknown as Host, distribution: {name: 'vivari', version: 'test', assetBaseUrl: '/runtime/'}, attached: false, clearing: false, closed: false});
    expect(await diagnoseWorkspaceEntry(workspace, '/link\nname')).toEqual({path: '/link\nname', metadata: {kind: 'symlink'}, target: '../missing\nfile'});
    expect(calls).toEqual([
      {type: 'vv-git-fs', data: {op: 'lstat', args: {path: '/workspace/link\nname'}}},
      {type: 'vv-git-fs', data: {op: 'readlink', args: {path: '/workspace/link\nname'}}},
    ]);
    workspaceInternals.get(workspace)!.clearing = true;
    await expect(diagnoseWorkspaceEntry(workspace, '/file')).rejects.toMatchObject({code: 'STORAGE_BUSY'});
    workspaceInternals.get(workspace)!.clearing = false;
    await expect(diagnoseWorkspaceEntry(workspace, '/../file')).rejects.toThrow("Expected an absolute workspace path");
    expect(calls).toHaveLength(2);
  });

  test('entry diagnostics retain directory name order and propagate lstat failures', async () => {
    const workspace = {} as Workspace;
    const names = ['z', 'line', 'break.txt'];
    workspaceInternals.set(workspace, {host: {
      request: async () => ({result: {kind: 'dir'}}),
      readdir: async (path: string) => { expect(path).toBe('/workspace/dir'); return names; },
    } as unknown as Host, distribution: {name: 'vivari', version: 'test', assetBaseUrl: '/runtime/'}, attached: false, clearing: false, closed: false});
    expect(await diagnoseWorkspaceEntry(workspace, '/dir')).toEqual({path: '/dir', metadata: {kind: 'dir'}, names});
    const error = new Error('EIO');
    workspaceInternals.get(workspace)!.host = {request: async () => { throw error; }} as unknown as Host;
    await expect(diagnoseWorkspaceEntry(workspace, '/dir')).rejects.toBe(error);
  });
});
