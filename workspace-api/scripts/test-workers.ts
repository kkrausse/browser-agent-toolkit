import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const result = await Bun.build({ entrypoints: [resolve(root, "tests/headless-contract.ts")], target: "node", format: "esm", external: ["../../vivari/*"], outdir: resolve(root, "tests"), naming: ".headless.mjs" });
if (!result.success) throw new AggregateError(result.logs);
const child = Bun.spawn(["bunx", "--package", "node-bin-darwin-arm64@24.18.0", "node", resolve(root, "tests/.headless.mjs")], { cwd: root, stdout: "inherit", stderr: "inherit" });
process.exitCode = await child.exited;
