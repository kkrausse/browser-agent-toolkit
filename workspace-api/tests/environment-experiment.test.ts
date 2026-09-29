import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ManagedEntry } from "../src/delivery-types"
import { ENVIRONMENT_RECEIPT, environmentExperimentKey, environmentVerificationScript, reusableEnvironmentExperiment, sourceReplacementScript } from "../src/environment-experiment"
import type { ToolContext } from '../src/types'

async function sandbox(task: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "editor-environment-experiment-"))
  try { await task(root) } finally { await rm(root, {recursive: true, force: true}) }
}
async function run(script: string): Promise<Record<string, unknown>> {
  const process = Bun.spawn([Bun.which("node") ?? "bun", "-e", script], {stdout: "pipe", stderr: "pipe"})
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
  if (code !== 0) throw new Error(stderr)
  return JSON.parse(stdout.trim()) as Record<string, unknown>
}
describe("environment experiment identity", () => {
  test("keys ignore source identity and invalidate runtime, pack or filesystem topology", async () => {
    const tree = {entries: [] as ManagedEntry[], roots: ["/managed"]}
    const key = await environmentExperimentKey({...tree, runtimeVersion: "r1", bundleSha256: "b1", imageSha256: "i1"})
    expect(key).not.toBe(await environmentExperimentKey({...tree, runtimeVersion: "r2", bundleSha256: "b1", imageSha256: "i1"}))
    expect(key).not.toBe(await environmentExperimentKey({...tree, runtimeVersion: "r1", bundleSha256: "b2", imageSha256: "i1"}))
    expect(key).not.toBe(await environmentExperimentKey({...tree, runtimeVersion: "r1", bundleSha256: "b1", imageSha256: "i2"}))
    expect(key).not.toBe(await environmentExperimentKey({...tree, roots: ["/different"], runtimeVersion: "r1", bundleSha256: "b1", imageSha256: "i1"}))
  })
})
describe("installed environment verification", () => {
  test("checks contents, missing/extra paths and exact symlinks", async () => {
    await sandbox(async root => {
      const bytes = "verified package"
      const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
      await writeFile(join(root, "file"), bytes)
      await chmod(root, 0o755)
      await chmod(join(root, "file"), 0o644)
      await symlink("file", join(root, "link"))
      const entries: ManagedEntry[] = [
        {kind: "directory", destination: root, mode: 0o755},
        {kind: "file", destination: join(root, "file"), mode: 0o644, file: sha256 + ".bin", bytes: bytes.length, sha256},
        {kind: "symlink", destination: join(root, "link"), target: "file"},
      ]
      const verify = (): Promise<Record<string, unknown>> => run(environmentVerificationScript(entries, [root]))
      expect((await verify()).valid).toBe(true)
      await writeFile(join(root, "file"), "tampered package")
      expect((await verify()).valid).toBe(false)
      await writeFile(join(root, "file"), bytes)
      await writeFile(join(root, "extra"), "unexpected")
      expect((await verify()).valid).toBe(false)
      await rm(join(root, "extra"))
      await rm(join(root, "link"))
      await symlink("./file", join(root, "link"))
      expect((await verify()).valid).toBe(false)
      await rm(join(root, "file"))
      expect((await verify()).valid).toBe(false)
    })
  })
  test('reuse verifies actual contents and redelivers after modification', async () => {
    await sandbox(async root => {
      const managed = join(root, 'managed')
      const bytes = 'package'
      const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
      const entries: ManagedEntry[] = [{kind: 'directory', destination: managed, mode: 0o755}, {kind: 'file', destination: join(managed, 'file'), mode: 0o644, file: sha256 + '.bin', bytes: bytes.length, sha256}]
      const local = (path: string): string => path.replace('/workspace', root)
      const context: ToolContext = {
        async readFile(path) { return new Uint8Array(await readFile(local(path))) },
        async installFile(path, bytes) {
          const file = local(path)
          if (await Bun.file(file).exists()) {
            if (!Buffer.from(await readFile(file)).equals(bytes)) throw new Error('Bundle conflict')
            return
          }
          await mkdir(join(file, '..'), {recursive: true})
          await writeFile(file, bytes)
        },
        async installTree() { throw new Error('not used') },
        async node(options) {
          const script = (await readFile(local(options.entry), 'utf8')).replaceAll('/workspace', root)
          const process = Bun.spawn([Bun.which('node') ?? 'bun', '-e', script], {stdout: 'pipe', stderr: 'pipe'})
          return {stdout: process.stdout, stderr: process.stderr, exited: process.exited.then(exitCode => ({exitCode, signal: null, forced: false})), closeStdin() {}, writeStdin() {}, async stop() { if (process.exitCode === null) process.kill(); await process.exited }}
        },
      }
      let installs = 0
      let fail = false
      const results: boolean[] = []
      const method = await reusableEnvironmentExperiment({key: 'verified-key', entries, roots: [managed], delivery: {name: 'fixture', version: '1', async bind() {
        return async () => {
          installs++
          if (fail) throw new Error('simulated partial installation')
          await mkdir(managed, {recursive: true})
          await chmod(managed, 0o755)
          await writeFile(join(managed, 'file'), bytes)
          await chmod(join(managed, 'file'), 0o644)
        }
      }}, report: result => results.push(result.reused)}).bind(context)
      await method()
      await method()
      expect(installs).toBe(1)
      expect(results).toEqual([false, true])
      await writeFile(join(managed, 'file'), 'changed')
      await method()
      expect(installs).toBe(2)
      await writeFile(join(managed, 'file'), 'changed')
      fail = true
      await expect(method()).rejects.toThrow('simulated partial installation')
      expect(await readFile(local(ENVIRONMENT_RECEIPT), 'utf8')).toBe('')
      fail = false
      await method()
      expect(results.at(-1)).toBe(false)
    })
  })
  test('disposable cache cleanup cannot remove declared packages or escape roots', () => {
    const entries: ManagedEntry[] = [{kind: 'directory', destination: '/managed', mode: 0o755}, {kind: 'directory', destination: '/managed/package', mode: 0o755}]
    expect(() => environmentVerificationScript(entries, ['/managed'], ['/managed/package'])).toThrow()
    expect(() => environmentVerificationScript(entries, ['/managed'], ['/managed/../elsewhere'])).toThrow()
    expect(() => environmentVerificationScript(entries, ['/managed'], ['/elsewhere'])).toThrow()
  })
})
describe("fixture source replacement", () => {
  for (const incremental of [false, true]) {
    test(`${incremental ? "incremental" : "full"} replacement handles binary files, deletion and file/directory transitions`, async () => {
      await sandbox(async root => {
        await mkdir(join(root, "node_modules"))
        await writeFile(join(root, "node_modules/keep"), "dependency")
        await writeFile(join(root, "same"), "unchanged")
        await writeFile(join(root, "gone"), "delete")
        await writeFile(join(root, "becomes-dir"), "old")
        await mkdir(join(root, "becomes-file"))
        await writeFile(join(root, "becomes-file/old"), "old")
        await symlink("node_modules/keep", join(root, "source-link"))
        const source = {"/same": "unchanged", "/becomes-dir/new": "new", "/becomes-file": "file", "/binary": {encoding: "base64" as const, data: "AAEC/w=="}}
        const script = sourceReplacementScript(source, incremental).replaceAll("/workspace", root).replace("'/.server'", JSON.stringify(join(root, "global-server")))
        const result = await run(script)
        expect(result.writes).toBe(incremental ? 3 : 4)
        expect(result.unchanged).toBe(incremental ? 1 : 0)
        expect(await readFile(join(root, "binary"))).toEqual(Buffer.from([0, 1, 2, 255]))
        expect(await readFile(join(root, "node_modules/keep"), "utf8")).toBe("dependency")
        expect(await Bun.file(join(root, "gone")).exists()).toBe(false)
        expect(await Bun.file(join(root, "source-link")).exists()).toBe(false)
      })
    })
  }
  test("rejects traversal and managed-root overlap before creating a script", () => {
    for (const path of ["/../bad", "/a/./bad", "/node_modules/x", "/.browser-editor-cache/x", "/a\\b"]) {
      expect(() => sourceReplacementScript({[path]: "bad"}, true)).toThrow()
    }
  })
})
