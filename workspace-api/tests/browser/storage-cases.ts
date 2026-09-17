import { type Runtime, type Workspace } from "../../src/index.js";
import { assert, browserCase, capture, equalBytes, mount, type BrowserTest } from "./harness.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function guest(workspace: Workspace, runtime: Runtime, source: string) {
  await mount(workspace, { "/storage-check.cjs": source });
  const result = await capture(await runtime.node({ entry: "/workspace/storage-check.cjs" }));
  assert(result.exit.exitCode === 0 && result.exit.signal === null && !result.exit.forced,
    `Storage guest failed: ${JSON.stringify(result.exit)}\n${decoder.decode(result.stderr)}`);
  equalBytes(result.stdout, encoder.encode("STORAGE_OK\n"));
}

// Deliberate test-only coupling to the retained OPFS mirror layout and lease name.
// Public reads see the RAM VFS, so they cannot prove that flush reached OPFS or
// cause a real backing-store error. Only test-owned paths are inspected/obstructed;
// no worker prototypes, host lifecycle, second kernel, or runtime hooks are used.
async function mirror() {
  const root = await navigator.storage.getDirectory();
  const base = await root.getDirectoryHandle("vv-vfs");
  const files = await base.getDirectoryHandle("files");
  return { base, files: await files.getDirectoryHandle("workspace") };
}

async function mirrorBytes(name: string) {
  const { files } = await mirror();
  const handle = await files.getFileHandle(name);
  return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}

async function rejects(run: () => Promise<unknown>, pattern: RegExp) {
  let failure: unknown;
  try { await run(); } catch (error) { failure = error; }
  assert(failure !== undefined && pattern.test(String(failure)),
    `Expected rejection matching ${pattern}, received ${String(failure)}`);
}

const sqlite = `
  const { DatabaseSync } = require('node:sqlite');
  const assert = require('node:assert/strict');
`;

export const storageTests: BrowserTest[] = [
  {
    name: "OPFS owner excludes a competing Web Lock and releases it on close",
    steps: [async () => {
      await browserCase(async ({ workspace }) => {
        await navigator.locks.request("vivari-vfs-owner", { ifAvailable: true }, lock => {
          assert(lock === null, "Live workspace did not exclusively own the OPFS lease");
        });
        await workspace.fs.writeFile("/lease.bin", new Uint8Array([0, 255, 42]));
        await workspace.flush();
        equalBytes(await mirrorBytes("lease.bin"), new Uint8Array([0, 255, 42]));
      });
      // A queued request also accommodates asynchronous worker termination. The
      // deadline turns a leaked lease into a failure rather than a hanging case.
      await navigator.locks.request("vivari-vfs-owner", { signal: AbortSignal.timeout(5_000) }, lock => {
        assert(lock !== null, "Orderly close did not release the OPFS lease");
      });
      await browserCase(async ({ workspace }) => {
        equalBytes(await workspace.fs.readFile("/lease.bin"), new Uint8Array([0, 255, 42]));
      });
    }],
  },
  {
    name: "concurrent writes and flushes persist final bytes, rename and deletion before close",
    steps: [
      () => browserCase(async ({ workspace }) => {
        await workspace.fs.mkdir("/batch");
        await Promise.all(Array.from({ length: 8 }, async (_, i) => {
          await workspace.fs.writeFile(`/batch/${i}.bin`, new Uint8Array([i, 0, 255]));
          await workspace.flush();
        }));
        await workspace.fs.rename("/batch", "/moved");
        await workspace.fs.remove("/moved/0.bin");
        // Shrinking a file must truncate the backing file, not leave its tail.
        await workspace.fs.writeFile("/moved/1.bin", new Uint8Array([128]));
        await Promise.all([workspace.flush(), workspace.flush(), workspace.flush()]);
        const { base, files } = await mirror();
        const moved = await files.getDirectoryHandle("moved");
        for (let i = 1; i < 8; i++) {
          const file = await (await moved.getFileHandle(`${i}.bin`)).getFile();
          equalBytes(new Uint8Array(await file.arrayBuffer()),
            i === 1 ? new Uint8Array([128]) : new Uint8Array([i, 0, 255]));
        }
        await rejects(() => files.getDirectoryHandle("batch"), /NotFoundError/);
        await rejects(() => moved.getFileHandle("0.bin"), /NotFoundError/);
        const manifest = JSON.parse(await (await (await base.getFileHandle("manifest.json")).getFile()).text()) as [string, unknown][];
        const paths = new Set(manifest.map(([path]) => path));
        assert(paths.has("/workspace/moved/1.bin"), "Flush did not publish renamed file in manifest");
        assert(![...paths].some(path => path === "/workspace/batch" || path.startsWith("/workspace/batch/")),
          "Manifest retained renamed subtree");
        assert(!paths.has("/workspace/moved/0.bin"), "Manifest retained deleted file");
      }),
      () => browserCase(async ({ workspace }) => {
        assert(!(await workspace.fs.readdir("/")).includes("batch"), "Renamed directory returned after reopen");
        assert(!(await workspace.fs.readdir("/moved")).includes("0.bin"), "Deleted file returned after reopen");
        for (let i = 1; i < 8; i++) equalBytes(await workspace.fs.readFile(`/moved/${i}.bin`),
          i === 1 ? new Uint8Array([128]) : new Uint8Array([i, 0, 255]));
      }),
    ],
  },
  {
    name: "OPFS backing-file failure rejects flush and a rewritten path recovers",
    steps: [() => browserCase(async ({ workspace }) => {
      await workspace.flush();
      const { files } = await mirror();
      await files.getDirectoryHandle("blocked.bin", { create: true });
      const bytes = new Uint8Array([0, 128, 255, 19]);
      try {
        await workspace.fs.writeFile("/blocked.bin", bytes);
        await rejects(() => workspace.flush(), /OPFS persistence failed/);
        assert(workspace.persistence.status === "failed", "Failed flush was not surfaced in persistence state");
        // RAM success must not be confused with a durable acknowledgement.
        equalBytes(await workspace.fs.readFile("/blocked.bin"), bytes);
        await rejects(() => workspace.flush(), /OPFS persistence failed/);
      } finally {
        await files.removeEntry("blocked.bin", { recursive: true });
        await workspace.fs.writeFile("/blocked.bin", bytes);
        await workspace.flush();
      }
      // The retained host latches its failed status; successful retry is checked
      // through flush acknowledgement and actual bytes, not a status reset that
      // the current persistence-state contract does not specify.
      equalBytes(await mirrorBytes("blocked.bin"), bytes);
    })],
  },
  {
    name: "SQLite pathname ownership, process-exit release, rollback and orderly reopen",
    steps: [
      () => browserCase(async ({ workspace, runtime }) => {
        await mount(workspace, { "/sqlite-owner.cjs": sqlite + `
          const db = new DatabaseSync('/workspace/owner.db');
          db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, bytes BLOB)');
          db.prepare('INSERT INTO items VALUES (?, ?)').run(1, Buffer.from([0, 255, 128]));
          assert.throws(() => new DatabaseSync('/workspace/owner.db'), /SQLITE_BUSY/);
          const server = require('node:http').createServer((req, res) => res.end('owned')).listen(3214);
          process.stdin.resume();
          // Intentionally leave db open: natural process exit must release it.
          process.stdin.on('end', () => server.close());
        ` });
        const owner = await runtime.node({ entry: "/workspace/sqlite-owner.cjs" });
        const ownerResult = capture(owner);
        const endpoint = await runtime.expose(3214, { signal: AbortSignal.timeout(15_000) });
        assert(await (await endpoint.fetch("/ready")).text() === "owned", "SQLite owner was not ready");
        // SQL has acknowledged the insert; no Workspace.flush or owner close
        // has occurred. Its exported database must already match real OPFS.
        const databaseBytes = await workspace.fs.readFile("/owner.db");
        assert(decoder.decode(databaseBytes.subarray(0, 16)) === "SQLite format 3\0", "Missing SQLite file header");
        equalBytes(await mirrorBytes("owner.db"), databaseBytes);
        await guest(workspace, runtime, sqlite + `
          assert.throws(() => new DatabaseSync('/workspace/owner.db'), /SQLITE_BUSY/);
          const independent = new DatabaseSync('/workspace/independent.db');
          independent.exec('CREATE TABLE independent (id INTEGER)');
          independent.close();
          console.log('STORAGE_OK');
        `);
        owner.closeStdin();
        const { exit } = await ownerResult;
        assert(exit.exitCode === 0 && exit.signal === null && !exit.forced, "SQLite owner did not exit naturally");
        await endpoint.closed;
        await guest(workspace, runtime, sqlite + `
          let db = new DatabaseSync('/workspace/owner.db');
          assert.deepEqual([...db.prepare('SELECT bytes FROM items WHERE id = 1').get().bytes], [0, 255, 128]);
          db.exec('BEGIN; INSERT INTO items VALUES (2, NULL); ROLLBACK');
          assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n, 1);
          assert.throws(() => db.exec('INSERT INTO items VALUES (1, NULL)'), /UNIQUE/);
          assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n, 1);
          db.close();
          db = new DatabaseSync('/workspace/owner.db');
          assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
          db.close();
          console.log('STORAGE_OK');
        `);
        await workspace.flush();
      }),
      () => browserCase(async ({ workspace, runtime }) => {
        await guest(workspace, runtime, sqlite + `
          const db = new DatabaseSync('/workspace/owner.db');
          assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n, 1);
          assert.deepEqual([...db.prepare('SELECT bytes FROM items WHERE id = 1').get().bytes], [0, 255, 128]);
          db.close();
          console.log('STORAGE_OK');
        `);
      }),
    ],
  },
  {
    name: "SQLite failed commit poisons connection and quarantines pathname until orderly restart",
    steps: [
      () => browserCase(async ({ workspace, runtime }) => {
        await mount(workspace, { "/sqlite-failure.cjs": sqlite + `
          const db = new DatabaseSync('/workspace/quarantine.db');
          db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY); INSERT INTO items VALUES (1)');
          const server = require('node:http').createServer((req, res) => {
            try {
              if (req.url === '/fail') {
                assert.throws(() => db.exec('INSERT INTO items VALUES (2)'), /OPFS persistence failed/);
                assert.throws(() => db.prepare('SELECT * FROM items'), /SQLITE_IOERR/);
                db.close();
                assert.throws(() => new DatabaseSync('/workspace/quarantine.db'), /SQLITE_IOERR/);
              }
              res.end('ok');
            } catch (error) { res.statusCode = 500; res.end(String(error.stack || error)); }
          }).listen(3215);
          process.stdin.resume();
          process.stdin.on('end', () => { db.close(); server.close(); });
        ` });
        const owner = await runtime.node({ entry: "/workspace/sqlite-failure.cjs" });
        const ownerResult = capture(owner);
        const endpoint = await runtime.expose(3215, { signal: AbortSignal.timeout(15_000) });
        assert(await (await endpoint.fetch("/ready")).text() === "ok", "SQLite failure fixture was not ready");
        await workspace.flush();
        const { files } = await mirror();
        await files.removeEntry("quarantine.db");
        try {
          await files.getDirectoryHandle("quarantine.db", { create: true });
          const response = await endpoint.fetch("/fail");
          const body = await response.text();
          assert(response.status === 200 && body === "ok", `SQLite failure assertions: ${body}`);
          await rejects(() => workspace.flush(), /OPFS persistence failed/);
        } finally {
          await files.removeEntry("quarantine.db", { recursive: true });
          // Repair persistence for orderly harness cleanup, not the SQLite owner.
          // A failed commit has an ambiguous outcome; do not claim it rolled back.
          const bytes = await workspace.fs.readFile("/quarantine.db");
          await workspace.fs.writeFile("/quarantine.db", bytes);
          await workspace.flush();
        }
        await guest(workspace, runtime, sqlite + `
          assert.throws(() => new DatabaseSync('/workspace/quarantine.db'), /SQLITE_IOERR/);
          console.log('STORAGE_OK');
        `);
        owner.closeStdin();
        const { exit } = await ownerResult;
        assert(exit.exitCode === 0 && !exit.forced, "SQLite failure fixture did not exit naturally");
        await endpoint.closed;
      }),
      () => browserCase(async ({ workspace, runtime }) => {
        await guest(workspace, runtime, sqlite + `
          const db = new DatabaseSync('/workspace/quarantine.db');
          assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
          assert.equal(db.prepare('SELECT id FROM items WHERE id = 1').get().id, 1);
          db.close();
          console.log('STORAGE_OK');
        `);
      }),
    ],
  },
];

// All multi-step cases use orderly close/reload (close itself flushes). Abrupt
// crash recovery, cross-document competing Workspace.open, quota exhaustion and
// manifest-write interruption need parent-runner orchestration, not claims based
// on these cases. The lease probe is an actual Web Lock contender, not a second
// workspace/kernel or full multi-tab qualification.
