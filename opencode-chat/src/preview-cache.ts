import type { Workspace } from '@kev-browser-agent-kit/workspace';

/** Keep Vite's derived output outside the disposable node_modules tree. Vite
 * still validates its own lock/config hashes and discovers new source imports. */
export async function preparePreviewCache(workspace: Pick<Workspace, 'fs'>, identity: string) {
  const directory = '/.browser-editor-cache', marker = directory + '/preparation';
  let existing = false;
  try { await workspace.fs.stat(directory); existing = true; } catch (error) {
    if (!String(error).includes('ENOENT')) throw error;
  }
  if (existing) {
    try {
      if (new TextDecoder().decode(await workspace.fs.readFile(marker)) === identity) return 'Reusing Vite dependency cache';
    } catch (error) { if (!String(error).includes('ENOENT')) throw error; }
    await workspace.fs.remove(directory);
  }
  await workspace.fs.mkdir(directory);
  await workspace.fs.writeFile(marker, new TextEncoder().encode(identity));
  return 'Preparing fresh Vite dependency cache';
}
