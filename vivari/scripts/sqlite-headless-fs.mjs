// Test host adapter only. The engine, VFS, FS server, protocol and guest runtime
// are production source. Disk snapshots exercise restart, not OPFS semantics.
import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { runtimeSourceUrl, runtimeSourcePath } from './runtime-source.mjs';
const { FsServer } = await import(runtimeSourceUrl('packages/kernel-host/fs-server.js').href);
const { createSqliteServer } = await import(runtimeSourceUrl('packages/kernel-host/sqlite-server.js').href);
const require = createRequire(runtimeSourceUrl('package.json'));
const { VirtualFileSystem } = require(runtimeSourcePath('packages/vfs/pkg-node/vivari_vfs.js'));
const vfs = new VirtualFileSystem();
vfs.mkdir("/runtime-probe", true); vfs.mkdir("/tmp", true);
for (const file of readdirSync(workerData.directory).filter(f => f.endsWith(".sqlite"))) {
  vfs.write_file(`/runtime-probe/${file}`, readFileSync(join(workerData.directory, file)));
}
const pending = new Set();
const persistence = {
  shouldPersist: path => /^\/runtime-probe\/[^/]+\.sqlite$/.test(path),
  onWrite(path) { if (this.shouldPersist(path)) pending.add(path); },
  onDelete() {}, onRename() {},
  async flush() {
    for (const path of pending) {
      const dest = join(workerData.directory, path.split("/").at(-1));
      writeFileSync(dest + ".tmp", vfs.read_file(path));
      renameSync(dest + ".tmp", dest);
      pending.delete(path);
    }
  },
};
const server = new FsServer(vfs, persistence);
server.sqlite = await createSqliteServer(vfs, persistence, {
  wasmBinary: readFileSync(require.resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm")),
});
parentPort.on("message", msg => {
  if (msg.type === "fs-register") server.register(msg.client, msg.sab, msg.port || null);
  else if (msg.type === "fs-unregister") server.unregister(msg.client);
  else if (msg.type === "fs") server.service(msg.client);
  else if (msg.type === "fs-write-large" || msg.type === "fs-write-batch") {
    try {
      if (msg.type === "fs-write-large") server.writeLarge(msg.path, new Uint8Array(msg.buffer, msg.byteOffset || 0, msg.byteLength));
      else server.writeBatch(msg.entries, msg.buffer);
      parentPort.postMessage({ type: msg.type + "-ok", id: msg.id });
    } catch (error) { parentPort.postMessage({ type: msg.type + "-err", id: msg.id, error: String(error) }); }
  }
});
parentPort.postMessage({ type: "ready" });
