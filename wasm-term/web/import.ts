// Bringing the user's own files into a guest's persistent directory, from the
// launcher: a folder (`<input webkitdirectory>`) or a .zip. The files go
// straight into the guest's IndexedDB store (host/persist-store.ts), which is
// where the program's persistent directories are loaded from when it starts;
// nothing is uploaded anywhere. Getting files back out is `wasmTerm.download`.

import { openPersistStore } from "../host/persist-store";

export interface ImportedFile {
  /** Relative to the directory being imported into, `/`-separated. */
  path: string;
  data: Uint8Array;
  /** Set when the file was left out before it was read: why. */
  skipped?: string;
}

export interface ImportResult {
  files: number;
  bytes: number;
  /** What was left out, and why. */
  skipped: string[];
}

/** Whole files are stored (and rewritten on every change), so a tree is kept small. */
export const IMPORT_LIMITS = { files: 5000, fileBytes: 8 << 20, totalBytes: 64 << 20 };

/** Version-control data and dependency trees: large, and nothing in the tab can use them. */
const LEFT_OUT = /(^|\/)(\.git|node_modules|__MACOSX|\.DS_Store|target|\.venv)(\/|$)/;

/** A folder picked with `webkitdirectory`: paths arrive as `<folder>/<rest>`; the folder's own name is dropped. */
export async function filesFromFolder(list: FileList): Promise<ImportedFile[]> {
  const out: ImportedFile[] = [];
  for (const file of Array.from(list)) {
    const relative = (file.webkitRelativePath || file.name).split("/").slice(file.webkitRelativePath ? 1 : 0).join("/");
    if (!relative || LEFT_OUT.test(relative) || file.size > IMPORT_LIMITS.fileBytes) {
      out.push({ path: relative || file.name, data: new Uint8Array(0), skipped: file.size > IMPORT_LIMITS.fileBytes ? "too large" : "not imported" });
      continue;
    }
    out.push({ path: relative, data: new Uint8Array(await file.arrayBuffer()) });
  }
  return out;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The files of a .zip archive (stored or deflated entries; no encryption, no zip64). */
export async function filesFromZip(archive: Uint8Array): Promise<ImportedFile[]> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  // End of central directory: the last 22 bytes, further back if the archive has a comment.
  let end = -1;
  for (let at = archive.length - 22; at >= Math.max(0, archive.length - 22 - 65535); at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip archive (no end-of-central-directory record)");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count === 0xffff || at === 0xffffffff) throw new Error("zip64 archives are not supported");
  const decoder = new TextDecoder();
  const entries: { name: string; method: number; packed: number; offset: number }[] = [];
  for (let index = 0; index < count; index++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("damaged zip archive (central directory)");
    const flags = view.getUint16(at + 8, true);
    const nameLength = view.getUint16(at + 28, true);
    const name = decoder.decode(archive.subarray(at + 46, at + 46 + nameLength));
    if (flags & 1) throw new Error(`encrypted entry in the zip archive: ${name}`);
    entries.push({ name, method: view.getUint16(at + 10, true), packed: view.getUint32(at + 20, true), offset: view.getUint32(at + 42, true) });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  // An archive of one folder (GitHub's "Download ZIP") is imported without that folder.
  const tops = new Set(entries.map(entry => entry.name.split("/")[0]));
  const strip = tops.size === 1 && entries.every(entry => entry.name.includes("/")) ? 1 : 0;
  const out: ImportedFile[] = [];
  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue;
    const path = entry.name.split("/").slice(strip).filter(part => part && part !== "." && part !== "..").join("/");
    if (!path) continue;
    if (LEFT_OUT.test(path)) {
      out.push({ path, data: new Uint8Array(0), skipped: "not imported" });
      continue;
    }
    const local = entry.offset;
    if (view.getUint32(local, true) !== 0x04034b50) throw new Error(`damaged zip archive (entry ${entry.name})`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const packed = archive.subarray(start, start + entry.packed);
    if (entry.method === 0) out.push({ path, data: packed.slice() });
    else if (entry.method === 8) out.push({ path, data: await inflate(packed) });
    else throw new Error(`zip entry ${entry.name} uses compression method ${entry.method}; only stored and deflated entries are supported`);
  }
  return out;
}

/** Stores `files` below `directory` of the guest's persistent files. `replace` removes what was stored below it first. */
export async function importIntoGuest(namespace: string, directory: string, files: ImportedFile[], replace: boolean): Promise<ImportResult> {
  const store = openPersistStore(namespace);
  const root = directory.replace(/\/+$/, "");
  const result: ImportResult = { files: 0, bytes: 0, skipped: [] };
  if (replace) {
    for (const path of Object.keys(await store.load())) if (path.startsWith(`${root}/`)) store.save(path, null);
  }
  for (const file of files) {
    if (file.skipped) result.skipped.push(file.path);
    else if (file.data.length > IMPORT_LIMITS.fileBytes) result.skipped.push(`${file.path} (larger than ${IMPORT_LIMITS.fileBytes >> 20} MB)`);
    else if (result.files >= IMPORT_LIMITS.files || result.bytes + file.data.length > IMPORT_LIMITS.totalBytes) result.skipped.push(`${file.path} (over the import limit)`);
    else {
      store.save(`${root}/${file.path}`, file.data);
      result.files++;
      result.bytes += file.data.length;
    }
  }
  await store.flush();
  return result;
}
