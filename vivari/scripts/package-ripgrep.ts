// Host packaging only. WASM execution/qualification belongs in Vivari.
// First: bun install --frozen-lockfile --cwd probes/ripgrep
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import ts from "typescript";

const root = resolve(import.meta.dir, "..");
const installation = resolve(root, "probes/ripgrep");
const pkg = resolve(installation, "node_modules/ripgrep");
const out = resolve(root, ".runtime/opencode-package");
const destination = "/opencode-packaged/node_modules/ripgrep";
const metadata = JSON.parse(await readFile(resolve(pkg, "package.json"), "utf8"));
if (metadata.version !== "0.3.1") throw Error(`Unexpected ripgrep ${metadata.version}`);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Decode exactly the published payload, without running ripgrep on the host.
const { getCompressedBytes } = await import(pathToFileURL(resolve(pkg, "lib/_rg.wasm.mjs")).href);
const wasm = brotliDecompressSync(getCompressedBytes());
if (!WebAssembly.validate(wasm)) throw Error("Published ripgrep payload is not valid WASM");
const wasmModule = await WebAssembly.compile(wasm);
const loaderPath = resolve(pkg, "lib/_rg.mjs");
const loader = await readFile(loaderPath, "utf8");
const shim = await readFile(resolve(pkg, "lib/_wasi.mjs"));
let replaced = 0;
// Only change asset delivery: retain the original WASM compiler, API and WASI
// runtime selection, and bundle the published _wasi.mjs without substitutions.
const packagedLoader = ts.transpileModule(loader, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  transformers: { before: [context => source => {
    const visit: ts.Visitor = node => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && ["node:zlib", "node:os", "node:path"].includes(node.moduleSpecifier.text)) return undefined;
      if (ts.isVariableStatement(node) && node.declarationList.declarations.every(d =>
        ts.isIdentifier(d.name) && ["WASM_HASH", "cacheFile"].includes(d.name.text))) return undefined;
      if (ts.isFunctionDeclaration(node) && node.name?.text === "getRgWasmBytes") {
        replaced++;
        return ts.factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken,
          node.name, node.typeParameters, node.parameters, node.type,
          ts.factory.createBlock([ts.factory.createReturnStatement(ts.factory.createCallExpression(
            ts.factory.createIdentifier("readFileSync"), undefined,
            [ts.factory.createStringLiteral(`${destination}/rg.wasm`)],
          ))], true));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(source, visit) as ts.SourceFile;
  }] },
}).outputText;
if (replaced !== 1) throw Error("Published ripgrep byte loader changed");
const external = ["node:*"];
const result = await Bun.build({
  entrypoints: [resolve(root, "probes/runtime/ripgrep.mjs")],
  target: "node", format: "esm", external,
  plugins: [{ name: "ripgrep-published-wasm", setup(build) {
    build.onResolve({ filter: /^ripgrep$/ }, () => ({ path: resolve(pkg, "lib/index.mjs") }));
    build.onLoad({ filter: /[/\\]_rg\.mjs$/ }, async args => {
      if (args.path === loaderPath) return { contents: packagedLoader, loader: "js", resolveDir: resolve(pkg, "lib") };
    });
  } }],
});
if (!result.success) throw new AggregateError(result.logs, "ripgrep packaging failed");
if (result.outputs.length !== 1) throw Error("Expected a single ripgrep JS bundle");
const bundled = await result.outputs[0].text();
if (/node:zlib|brotliDecompressSync|getCompressedBytes/.test(bundled)) throw Error("Guest bundle still requires Brotli decoding");
const lowered = ts.transpileModule(bundled, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  transformers: { before: [context => source => {
    const visit: ts.Visitor = node => ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword
      ? ts.factory.createIdentifier("__packageMeta") : ts.visitEachChild(node, visit, context);
    return ts.visitNode(source, visit) as ts.SourceFile;
  }] },
}).outputText;
const bytes = new TextEncoder().encode(`#!/usr/bin/env node\n(async function() {\nconst __packageMeta = { url: require('node:url').pathToFileURL(__filename).href };\n${lowered}\n})().catch(e => { console.error(e.stack ?? String(e)); process.exitCode = 2; });\n`);
// Parse the CJS wrapper without executing the packaged command.
new Function("require", "module", "exports", "__filename", "__dirname", new TextDecoder().decode(bytes).replace(/^#![^\n]*\n/, ""));
await mkdir(out, { recursive: true });
const assets: { file: string; destination: string; bytes: number; sha256: string }[] = [];
async function asset(file: string, destination: string, data: Uint8Array) {
  await writeFile(resolve(out, file), data);
  const receipt = { file, destination, bytes: data.length, sha256: sha256(data) };
  assets.push(receipt);
  return receipt;
}
const executable = await asset("rg.txt", "/bin/rg", bytes);
await asset("rg-wasm.bin", `${destination}/rg.wasm`, wasm);
for (const name of ["package.json", ...(await readdir(pkg)).filter(f => /^(license|copying|notice)/i.test(f))]) {
  await asset(`rg-asset-${assets.length}.bin`, `${destination}/${name}`, await readFile(resolve(pkg, name)));
}
const receipt = {
  ...executable, ripgrep: metadata.version, bun: Bun.version, typescript: ts.version,
  target: "node", external, entry: "ripgrep", assets,
  lockSha256: sha256(await readFile(resolve(installation, "bun.lock"))),
  shimSha256: sha256(shim),
  wasmImports: WebAssembly.Module.imports(wasmModule),
  packaging: ["Published z85+Brotli WASM decoded on host into rg-wasm.bin",
    "Byte loader reads fixed receipt-managed rg.wasm; published WASI shim unchanged",
    "Bun Node-target ESM bundle lowered to CommonJS with TypeScript and async wrapper"],
  note: "Host packaging only; qualification is separate. Mount every asset. The tools probe also provisions OpenCode's binary cache because Vivari chmod is a no-op. nodeWasi:false; actual ripgrep exit code. Published shim treats stdin as EOF and poll_oneoff as NOTSUP. WASM requires SIMD.",
};
await writeFile(resolve(out, "rg-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(receipt);
