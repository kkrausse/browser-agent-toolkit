// Page side of persistent directories: files in IndexedDB, keyed by a
// namespace (one per program, so guests do not see each other's home) and the
// file's absolute path. IndexedDB rather than OPFS because it is the same in
// every browser, including Safari on iOS, and the files are small.

const DATABASE = "wasm-term";
const STORE = "files";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
}

const prefix = (namespace: string) => `${namespace}\n`;
const range = (namespace: string) => IDBKeyRange.bound(prefix(namespace), `${namespace}\n￿`);

export interface PersistStore {
  /** Every stored file of the namespace (absolute path → contents). */
  load(): Promise<Record<string, Uint8Array>>;
  /** Stores (`data`) or removes (`null`) one file. Writes are applied in call order. */
  save(path: string, data: Uint8Array | null): void;
  /** Removes every file of the namespace. */
  clear(): Promise<void>;
}

export function openPersistStore(namespace: string): PersistStore {
  let database: Promise<IDBDatabase> | undefined;
  const db = () => (database ??= open());
  let queue: Promise<void> = Promise.resolve();

  return {
    async load() {
      const transaction = (await db()).transaction(STORE, "readonly");
      const files: Record<string, Uint8Array> = {};
      const request = transaction.objectStore(STORE).openCursor(range(namespace));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        files[String(cursor.key).slice(prefix(namespace).length)] = new Uint8Array(cursor.value as ArrayBuffer);
        cursor.continue();
      };
      await done(transaction);
      return files;
    },
    save(path, data) {
      queue = queue
        .then(async () => {
          const transaction = (await db()).transaction(STORE, "readwrite");
          const store = transaction.objectStore(STORE);
          // A plain ArrayBuffer copy: the incoming view may sit on a SharedArrayBuffer-free transfer, but never store a view's whole backing buffer.
          if (data) store.put(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), prefix(namespace) + path);
          else store.delete(prefix(namespace) + path);
          await done(transaction);
        })
        .catch(error => console.warn(`wasm-term: could not persist ${path}`, error));
    },
    async clear() {
      await queue;
      const transaction = (await db()).transaction(STORE, "readwrite");
      transaction.objectStore(STORE).delete(range(namespace));
      await done(transaction);
    },
  };
}
