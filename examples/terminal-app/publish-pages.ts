#!/usr/bin/env bun
// Publishes an already built public directory (`PUBLIC=1 OUT_DIR=dist-public bun run build`)
// as the repository's GitHub Pages branch: one commit with no parent, pushed with force, so
// that 55 MB builds do not pile up in the branch's history. Nothing of this checkout's
// branches is touched: the commit is made in a scratch repository and pushed from there.
//
//   bun publish-pages.ts [directory] --yes [--remote origin] [--branch gh-pages]
//
//   directory   default dist-public
//   --yes       required: without it the checks run, the plan is printed, nothing is pushed
//   --remote    a remote of this checkout or a URL or path (default origin)
//   --branch    default gh-pages; `main` and `master` are refused
//
// What Pages needs for these files, and what is checked here:
//   .nojekyll              added: without it Jekyll drops names that start with `_` or `.`
//   every file < 100 MB    GitHub refuses larger ones; the largest is printed
//   <name>.gz              served as they are (application/gzip, no Content-Encoding); the
//                          page's service worker inflates them
//   sw.js at a subpath     its scope is the page's directory (`/<repository>/`), which needs
//                          no header; every URL of the page is relative
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = (name: string) => { const at = args.indexOf(`--${name}`); return at < 0 ? undefined : args[at + 1] }
const positional = args.filter((arg, at) => !arg.startsWith('--') && !['--remote', '--branch'].includes(args[at - 1] ?? ''))
const here = import.meta.dirname
const directory = resolve(here, positional[0] ?? 'dist-public')
const remote = flag('remote') ?? 'origin', branch = flag('branch') ?? 'gh-pages'
const limit = 100 * 1024 * 1024

function git(cwd: string, ...command: string[]): string {
  const result = Bun.spawnSync(['git', ...command], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw Error(`git ${command.join(' ')}: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`)
  return result.stdout.toString().trim()
}
const walk = (root: string, prefix = ''): string[] => readdirSync(root, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(join(root, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`])

if (/^(main|master)$/.test(branch)) throw Error(`Refusing to publish to ${branch}: this replaces the whole branch`)
if (!existsSync(join(directory, 'index.html'))) throw Error(`No ${directory}/index.html: build first (PUBLIC=1 OUT_DIR=dist-public bun run build)`)
// The development build ships these two; a page for strangers must not be one.
for (const name of ['client-tap.js', 'openai-jwks.json']) if (existsSync(join(directory, name))) throw Error(`${directory} has ${name}: it is a development build, not a public one (PUBLIC=1)`)

const files = walk(directory).map(path => ({ path, bytes: statSync(join(directory, path)).size })).sort((a, b) => b.bytes - a.bytes)
const total = files.reduce((sum, file) => sum + file.bytes, 0)
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`
const tooBig = files.filter(file => file.bytes >= limit)
if (tooBig.length) throw Error(`GitHub refuses files of 100 MB or more: ${tooBig.map(file => `${file.path} (${mb(file.bytes)})`).join(', ')}`)
const hidden = files.filter(file => file.path.split('/').some(part => /^[._]/.test(part)))
// A name of this checkout's remotes, or an address as it is.
const url = Bun.spawnSync(['git', 'remote', 'get-url', remote], { cwd: here, stdout: 'pipe', stderr: 'pipe' })
const target = url.exitCode === 0 ? url.stdout.toString().trim() : remote
console.log(`${directory}: ${files.length} files, ${mb(total)}; largest ${files[0]!.path} (${mb(files[0]!.bytes)}, limit 100 MB)`)
if (hidden.length) console.log(`names starting with "." or "_" (kept, since .nojekyll is added): ${hidden.map(file => file.path).join(', ')}`)
console.log(`to: ${target}, branch ${branch}, as one commit without a parent (force)`)
if (!args.includes('--yes')) { console.error('Nothing was pushed: pass --yes to publish.'); process.exit(1) }

const source = git(here, 'rev-parse', '--short', 'HEAD')
const scratch = mkdtempSync(join(tmpdir(), 'bat-pages-'))
try {
  cpSync(directory, scratch, { recursive: true })
  writeFileSync(join(scratch, '.nojekyll'), '')
  git(scratch, 'init', '--quiet', '--initial-branch', branch)
  for (const key of ['user.name', 'user.email']) git(scratch, 'config', key, git(here, 'config', key))
  git(scratch, 'add', '--all')
  git(scratch, 'commit', '--quiet', '-m', `The terminal example's public build, from ${source}`)
  git(scratch, 'push', '--force', target, `HEAD:refs/heads/${branch}`)
  console.log(`Pushed ${git(scratch, 'rev-parse', '--short', 'HEAD')} to ${branch}`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
