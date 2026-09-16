// Test-only disk persistence adapter. Real Rust VFS/SQLite/protocol; NOT OPFS evidence.
import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runtimeSourceUrl } from "../../vivari/scripts/runtime-source.mjs";
const { FsServer } = await import(runtimeSourceUrl("packages/kernel-host/fs-server.js").href);
const { createSqliteServer } = await import(runtimeSourceUrl("packages/kernel-host/sqlite-server.js").href);
const require = createRequire(runtimeSourceUrl("package.json"));
const { VirtualFileSystem } = require("./packages/vfs/pkg-node/vivari_vfs.js");
const vfs = new VirtualFileSystem();
for (const file of readdirSync(workerData.directory).filter(f => f.endsWith(".snapshot"))) {
  const path = Buffer.from(file.slice(0, -9), "base64url").toString();
  vfs.mkdir(path.slice(0, path.lastIndexOf("/")), true);
  vfs.write_file(path, readFileSync(join(workerData.directory, file)));
}
const pending = new Set();
const persistence = {
  shouldPersist: path => path.startsWith("/workspace/") && !path.includes("/node_modules/"),
  onWrite(path) { if (this.shouldPersist(path)) pending.add(path); },
  onDelete() {}, onRename() {},
  async flush() {
    for (const path of pending) {
      if (!vfs.exists(path) || JSON.parse(vfs.lstat(path)).kind !== "file") { pending.delete(path); continue; }
      const dest = join(workerData.directory, Buffer.from(path).toString("base64url") + ".snapshot");
      writeFileSync(dest + ".tmp", vfs.read_file(path)); renameSync(dest + ".tmp", dest); pending.delete(path);
    }
  },
};
const server = new FsServer(vfs, persistence);
server.onMutation = path => parentPort.postMessage({ type: "vv-fs-changed", path });
server.sqlite = await createSqliteServer(vfs, persistence, { wasmBinary: readFileSync(require.resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm")) });
parentPort.on("message", msg => {
  if (msg.type === "fs-register") server.register(msg.client, msg.sab, msg.port || null);
  else if (msg.type === "fs-unregister") server.unregister(msg.client);
  else if (msg.type === "fs") server.service(msg.client);
  else if (msg.type === "workspace-read") {
    try { parentPort.postMessage({ type: "vv-reply", reqId: msg.reqId, bytes: vfs.read_file(msg.path), ok: true }); }
    catch (error) { parentPort.postMessage({ type: "vv-reply", reqId: msg.reqId, error: String(error), ok: false }); }
  } else if (msg.type === "fs-write-large" || msg.type === "fs-write-batch") {
    try {
      if (msg.type === "fs-write-large") server.writeLarge(msg.path, new Uint8Array(msg.buffer, msg.byteOffset || 0, msg.byteLength));
      else server.writeBatch(msg.entries, msg.buffer);
      parentPort.postMessage({ type: msg.type + "-ok", id: msg.id });
    } catch (error) { parentPort.postMessage({ type: msg.type + "-err", id: msg.id, error: String(error) }); }
  } else if (msg.type === "test-flush") {
    persistence.flush().then(
      () => parentPort.postMessage({ type: "vv-reply", reqId: msg.reqId, ok: true }),
      error => parentPort.postMessage({ type: "vv-reply", reqId: msg.reqId, ok: false, error: String(error) }),
    );
  }
});
parentPort.postMessage({ type: "ready" });
