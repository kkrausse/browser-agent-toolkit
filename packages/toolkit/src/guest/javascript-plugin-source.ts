/** Build-time macro: ship one self-contained guest plugin, including its Effect runtime. */
export function javascriptPluginSource(): string {
  // Nested Bun.build calls deadlock inside a bundler macro; use a separate build process.
  const result = Bun.spawnSync([process.execPath, 'build', new URL('./javascript-plugin.ts', import.meta.url).pathname,
    '--target=node', '--format=esm', '--minify'], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw Error('Could not bundle guest JavaScript plugin: ' + result.stderr.toString());
  return result.stdout.toString();
}
