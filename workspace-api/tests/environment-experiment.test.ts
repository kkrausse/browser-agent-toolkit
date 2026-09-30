import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ManagedEntry } from "../src/delivery-types"
import { ENVIRONMENT_RECEIPT, environmentExperimentKey, environmentVerificationScript, installedEnvironmentAuditScript, reusableEnvironmentExperiment, sourceReplacementScript } from "../src/environment-experiment"
import type { ToolContext } from '../src/types'

async function sandbox(task: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "editor-environment-experiment-")))
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
describe("bounded stopped installed/cache audit", () => {
  async function tree(task: (root: string, entries: ManagedEntry[], cache: string) => Promise<void>) {
    await sandbox(async temporary => {
      const root = await realpath(temporary), managed = join(root, "node_modules"), cache = join(managed, ".vite")
      await mkdir(cache, { recursive: true })
      await chmod(managed, 0o755)
      await writeFile(join(managed, "package"), "package")
      await chmod(join(managed, "package"), 0o644)
      await writeFile(join(cache, "chunk.js"), "cached bytes")
      await chmod(join(cache, "chunk.js"), 0o644)
      const sha256 = new Bun.CryptoHasher("sha256").update("package").digest("hex")
      await task(root, [
        { kind: "directory", destination: managed, mode: 0o755 },
        { kind: "file", destination: join(managed, "package"), mode: 0o644, file: sha256 + ".bin", bytes: 7, sha256 },
      ], cache)
    })
  }
  test("exact installed verification plus immutable cache inventory survives source replacement", async () => {
    await tree(async (root, entries, cache) => {
      const audit = () => run(installedEnvironmentAuditScript(entries, [join(root, "node_modules")], { paths: [cache] }))
      const before = await audit()
      expect(before.valid).toBe(true); expect(before.checked).toBe(2)
      expect(before.cacheBytes).toBe(12)
      expect((await run(environmentVerificationScript(entries, [join(root, "node_modules")]))).valid).toBe(false)
      await writeFile(join(root, "outgoing"), "old")
      await run(sourceReplacementScript({ "/incoming": "new" }, true).replaceAll("/workspace", root).replace("'/.server'", JSON.stringify(join(root, "global-server"))))
      const after = await audit()
      expect(after).toEqual(before)
      expect(await Bun.file(join(root, "outgoing")).exists()).toBe(false)
      await writeFile(join(cache, "chunk.js"), "cache tamper")
      expect((await audit()).cacheDigest).not.toBe(before.cacheDigest)
      await writeFile(join(root, "node_modules/package"), "tamper!")
      expect((await audit()).valid).toBe(false)
    })
  })
  test("digest covers missing caches, modes, rename and sorted inventory", async () => {
    await tree(async (root, entries, cache) => {
      const audit = () => run(installedEnvironmentAuditScript(entries, [join(root, "node_modules")], { paths: [cache, cache + "-temp"] }))
      const before = await audit()
      expect(before.valid).toBe(true)
      expect(before.inventory).toContainEqual({ path: cache + "-temp", kind: "absent" })
      await chmod(join(cache, "chunk.js"), 0o600)
      const modeChanged = await audit(); expect(modeChanged.cacheDigest).not.toBe(before.cacheDigest)
      await writeFile(join(cache, "renamed.js"), "cached bytes"); await rm(join(cache, "chunk.js"))
      expect((await audit()).cacheDigest).not.toBe(modeChanged.cacheDigest)
      await rm(cache, { recursive: true })
      const absent = await audit(); expect(absent.valid).toBe(true); expect(absent.cacheDigest).not.toBe(before.cacheDigest)
    })
  })
  test("rejects cache symlinks, dangling symlinks and symlink ancestors without following", async () => {
    await tree(async (root, entries, cache) => {
      const audit = () => run(installedEnvironmentAuditScript(entries, [join(root, "node_modules")], { paths: [cache] }))
      await symlink("../package", join(cache, "redirect"))
      expect((await audit()).valid).toBe(false)
      await rm(join(cache, "redirect")); await symlink("missing", join(cache, "redirect"))
      expect((await audit()).valid).toBe(false)
      await rm(cache, { recursive: true }); await symlink(root, cache)
      expect((await audit()).valid).toBe(false)
      const external = installedEnvironmentAuditScript(entries, [join(root, "node_modules")], { paths: ["/workspace/.browser-editor-cache/vite"] }).replaceAll("/workspace", root)
      await symlink(root, join(root, ".browser-editor-cache"))
      expect((await run(external)).valid).toBe(false)
    })
  })
  test("entry/file/total/depth limits reject rather than ignore oversized caches", async () => {
    await tree(async (root, entries, cache) => {
      for (const limits of [{ maxEntries: 1 }, { maxFileBytes: 1 }, { maxTotalBytes: 1 }]) {
        const result = await run(installedEnvironmentAuditScript(entries, [join(root, "node_modules")], { paths: [cache], ...limits }))
        expect(result.valid).toBe(false); expect(result.reason).toContain("limit")
      }
      await mkdir(join(cache, "a/b"), { recursive: true })
      expect((await run(installedEnvironmentAuditScript(entries, [join(root, "node_modules")], { paths: [cache], maxDepth: 1 }))).valid).toBe(false)
      await writeFile(join(root, "node_modules/extra"), "extra")
      expect((await run(installedEnvironmentAuditScript(entries, [join(root, "node_modules")], { paths: [cache] }))).valid).toBe(false)
    })
  })
  test("cache exception does not waive immutable symlinks, modes or missing files", async () => {
    await tree(async (root, entries, cache) => {
      const managed = join(root, "node_modules"), link = join(managed, "link")
      await symlink("package", link)
      entries.push({ kind: "symlink", destination: link, target: "package" })
      const audit = () => run(installedEnvironmentAuditScript(entries, [managed], { paths: [cache] }))
      expect((await audit()).valid).toBe(true)
      await rm(link); await symlink("./package", link)
      expect((await audit()).valid).toBe(false)
      await rm(link); await symlink("package", link); await chmod(join(managed, "package"), 0o600)
      expect((await audit()).valid).toBe(false)
      await chmod(join(managed, "package"), 0o644); await rm(join(managed, "package"))
      expect((await audit()).valid).toBe(false)
    })
  })
  test("policy rejects traversal, overlaps, unknown external roots and excessive limits", () => {
    const entries: ManagedEntry[] = [{ kind: "directory", destination: "/managed", mode: 0o755 }, { kind: "file", destination: "/managed/package", mode: 0o644, file: "x", bytes: 1, sha256: "x" }]
    for (const paths of [["/managed"], ["/managed/package"], ["/managed/package/cache"], ["/managed/../other"], ["/other/cache"], ["/managed/cache", "/managed/cache"], ["/managed/cache", "/managed/cache/nested"]]) expect(() => installedEnvironmentAuditScript(entries, ["/managed"], { paths })).toThrow()
    for (const maxEntries of [0, -1, 1.5, 10001, NaN]) expect(() => installedEnvironmentAuditScript(entries, ["/managed"], { paths: [], maxEntries })).toThrow()
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
  for (const preserving of [false, true]) test(`reuse ${preserving ? 'with audited caches ' : ''}verifies actual contents and redelivers after modification`, async () => {
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
           await rm(managed, {recursive: true, force: true})
           await mkdir(managed, {recursive: true})
          await chmod(managed, 0o755)
          await writeFile(join(managed, 'file'), bytes)
          await chmod(join(managed, 'file'), 0o644)
        }
       }}, ...(preserving ? { preserveCaches: { servicesStopped: true as const, policy: { paths: [join(managed, '.vite'), '/workspace/.browser-editor-cache/vite'] } } } : {}), report: result => {
         results.push(result.reused)
         if (preserving && result.reused) expect(result.audit?.valid).toBe(true)
       }}).bind(context)
       await method()
       if (preserving) {
         await mkdir(join(managed, '.vite'))
         await writeFile(join(managed, '.vite/chunk.js'), 'cache preserved')
         await mkdir(local('/workspace/.browser-editor-cache/vite'))
         await writeFile(local('/workspace/.browser-editor-cache/vite/chunk.js'), 'external cache preserved')
       }
       await method()
      expect(installs).toBe(1)
       expect(results).toEqual([false, true])
       if (preserving) expect(await readFile(join(managed, '.vite/chunk.js'), 'utf8')).toBe('cache preserved')
       if (preserving) expect(await readFile(local('/workspace/.browser-editor-cache/vite/chunk.js'), 'utf8')).toBe('external cache preserved')
      await writeFile(join(managed, 'file'), 'changed')
      await method()
       expect(installs).toBe(2)
       if (preserving) expect(await Bun.file(local('/workspace/.browser-editor-cache/vite/chunk.js')).exists()).toBe(false)
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
