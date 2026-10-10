#!/usr/bin/env node
// Project script for bat-prepare (policy `projectScripts`, see crates/bat-prepare/src/policy.rs):
// produce Vite's dependency-optimizer cache at prepare time, for the guest's exact project,
// configuration and paths, so that the guest's Vite finds it fresh and never runs the
// optimizer at startup.
//
// How: the guest's project files are written next to the guest node_modules (the same
// layout as the guest's /workspace), and the project's own Vite dev server is started
// there once (vite-optimize-runner.mjs) with the guest's launch environment.
//   - With bubblewrap (Linux): the directory is mounted at the guest workspace path in a
//     mount namespace, so every path and hash Vite computes is the guest's. Nothing is
//     rewritten.
//   - Without it: Vite runs at the host path and the runner recomputes the config and
//     lockfile hashes for the guest root (self-checked, see the runner). Per-file hashes
//     then still carry the host path; Vite only compares those between two of its own runs,
//     so the first re-optimization in the guest reloads the page where it might not have.
// The cache directories (<cacheDir>/deps, deps_<environment>) are copied to BAT_SCRIPT_OUT.
// Results are reused from BAT_SCRIPT_CACHE while project files, image and launch are unchanged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const need = name => process.env[name] ?? (console.error(`vite-optimize-deps: ${name} is not set`), process.exit(2));
const nodeModules = need('BAT_GUEST_NODE_MODULES'), out = need('BAT_SCRIPT_OUT'), cache = need('BAT_SCRIPT_CACHE'), workspace = need('BAT_WORKSPACE');
const project = JSON.parse(fs.readFileSync(need('BAT_PROJECT_FILES'), 'utf8'));
const preview = JSON.parse(process.env.BAT_LAUNCH ?? '{}').preview ?? {};
const stage = path.dirname(nodeModules);
const runner = fs.readFileSync(path.join(here, 'vite-optimize-runner.mjs'));
const bwrap = process.env.BAT_NO_BWRAP ? null : ['/usr/bin/bwrap', '/bin/bwrap'].find(file => fs.existsSync(file)) ?? null;

const key = crypto.createHash('sha256')
  .update(JSON.stringify([project, preview.env ?? {}, workspace, process.env.BAT_IMAGE_SHA256 ?? '', !!bwrap, process.version.split('.')[0]]))
  .update(runner).update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 24);
const kept = path.join(cache, key);
const copyTree = (from, to) => fs.cpSync(from, to, { recursive: true });
if (fs.existsSync(path.join(kept, 'result.json'))) {
  copyTree(path.join(kept, 'files'), out);
  console.error(`vite-optimize-deps: reused (${key})`);
  process.exit(0);
}

// ---- stage: the guest's project files beside its node_modules
const listFile = path.join(cache, 'staged-files.json');
for (const file of fs.existsSync(listFile) ? JSON.parse(fs.readFileSync(listFile, 'utf8')) : []) fs.rmSync(path.join(stage, file), { force: true });
const staged = [];
for (const [guestPath, content] of Object.entries(project)) {
  const relative = guestPath.replace(/^\/+/, '');
  if (relative.split('/')[0] === 'node_modules') continue;
  const file = path.join(stage, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : Buffer.from(content.data, 'base64'));
  staged.push(relative);
}
fs.mkdirSync(cache, { recursive: true });
fs.writeFileSync(listFile, JSON.stringify(staged));

// ---- run the project's Vite once
const resultName = '.bat-optimize-result.json';
const resultFile = path.join(stage, resultName);
fs.rmSync(resultFile, { force: true });
const env = { ...process.env, ...preview.env };
for (const name of Object.keys(env)) if (name.startsWith('BAT_')) delete env[name];
let command, args, cwd;
if (bwrap) {
  // The host's file system as it is, plus the stage at the guest's workspace path.
  const binds = fs.readdirSync('/').filter(name => !['proc', 'dev', 'sys', workspace.split('/')[1]].includes(name)).flatMap(name => ['--bind', '/' + name, '/' + name]);
  command = bwrap;
  args = ['--die-with-parent', ...binds, '--dev', '/dev', '--proc', '/proc', '--bind', stage, workspace, '--ro-bind', here, '/.bat-prepare', '--chdir', workspace,
    process.execPath, '/.bat-prepare/vite-optimize-runner.mjs', path.posix.join(workspace, resultName)];
  cwd = '/';
} else {
  command = process.execPath;
  args = [path.join(here, 'vite-optimize-runner.mjs'), resultFile, '--rehash', workspace];
  cwd = stage;
}
// At the host path Tailwind and friends would look at the host's surroundings (a
// repository root above the stage), so the page walk is only done in the namespace.
if (process.env.BAT_OPTIMIZE_NO_CRAWL || !bwrap) args.push('--no-crawl');
const started = performance.now();
const run = spawnSync(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 180_000 });
if (run.status !== 0 || !fs.existsSync(resultFile)) {
  console.error(`vite-optimize-deps: the dev server run failed (status ${run.status}, signal ${run.signal})\n${run.stdout}\n${run.stderr}`);
  process.exit(1);
}
const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
fs.rmSync(resultFile, { force: true });
result.mode = bwrap ? 'mounted at the guest path' : 'host path, hashes recomputed';
if (!result.ok) {
  console.error(`vite-optimize-deps: no usable cache: ${JSON.stringify(result)}`);
  process.exit(1);
}

// ---- collect: <cacheDir>/deps* as project files
for (const environment of Object.values(result.environments)) if (environment.cacheDir?.split('/').includes('node_modules')) {
  // That tree is the dependency image; project files cannot be placed in it.
  console.error(`vite-optimize-deps: the cache directory ${environment.cacheDir} is inside node_modules; set cacheDir outside it for the guest`);
  process.exit(1);
}
const files = path.join(kept, 'files');
fs.rmSync(kept, { recursive: true, force: true });
let count = 0, bytes = 0;
for (const environment of Object.values(result.environments)) {
  if (!environment.cacheDir) continue;
  const from = path.join(stage, environment.cacheDir);
  for (const name of fs.readdirSync(from)) {
    const target = path.join(files, environment.cacheDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(from, name), target);
    count++; bytes += fs.statSync(target).size;
  }
}
// Tools that walk the project for source files (Tailwind's scanner) skip what a .gitignore
// names. In the guest the cache directory is inside the workspace, which has no .gitignore
// of its own, so megabytes of optimized dependencies would be scanned for class names on
// every stylesheet transform, and the generated CSS would depend on whether the optimizer
// had already written its output.
for (const environment of Object.values(result.environments)) if (environment.cacheDir) {
  const ignore = path.join(files, path.dirname(environment.cacheDir), '.gitignore');
  if (!fs.existsSync(ignore)) { fs.writeFileSync(ignore, '*\n'); count++; }
}
// Leave the stage as it was found.
for (const environment of Object.values(result.environments)) if (environment.cacheDir) fs.rmSync(path.join(stage, environment.cacheDir), { recursive: true, force: true });
fs.writeFileSync(path.join(kept, 'result.json'), JSON.stringify(result, null, 1));
copyTree(files, out);
const summary = Object.entries(result.environments).map(([name, e]) => `${name}: ${e.cacheDir ? `${e.optimized.length} dependencies, ${e.chunks} chunks` : 'nothing to optimize'}`).join('; ');
console.error(`vite-optimize-deps: ${count} files, ${(bytes / 1e6).toFixed(1)} MB in ${Math.round(performance.now() - started)} ms (${result.mode}; ${summary}; crawl ${JSON.stringify(result.crawl)})`);
