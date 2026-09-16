import type { Workspace } from "@kev-browser-agent-kit/workspace";

export type SourceWorkspace = Pick<Workspace, "fs" | "flush">;
export async function sourcePaths(workspace: SourceWorkspace, directory = "/"): Promise<string[]> {
  const paths: string[] = [];
  for (const name of await workspace.fs.readdir(directory)) {
    if (["node_modules", ".git", ".opencode-state", ".server", ".browser-editor-backends", ".browser-editor-cache"].includes(name)) continue;
    const path = `${directory === "/" ? "" : directory}/${name}`;
    if ((await workspace.fs.stat(path)).isDirectory) paths.push(...await sourcePaths(workspace, path));
    else paths.push(path);
  }
  return paths.sort();
}
