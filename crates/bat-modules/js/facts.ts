// Module facts: the 32-bit word and the blob, as written by the Rust crate
// (crates/bat-modules/src/facts.rs) and specified in docs/design/module-format.md.

export const KIND_CJS = 1;
export const KIND_ESM = 2;
export const KIND_JSON = 3;

export const FLAG_ASYNC = 1 << 3;
export const FLAG_IMPORT_META = 1 << 4;
export const FLAG_DYNAMIC_IMPORT = 1 << 5;
export const FLAG_USES_REQUIRE = 1 << 6;
export const FLAG_USES_MODULE = 1 << 7;
export const FLAG_USES_EXPORTS = 1 << 8;
export const FLAG_USES_FILENAME = 1 << 9;
export const FLAG_USES_DIRNAME = 1 << 10;
export const FLAG_ES_MODULE_MARKER = 1 << 11;
export const FLAG_HAS_DEFAULT = 1 << 12;
export const FLAG_HAS_REEXPORTS = 1 << 13;
export const FLAG_CODE_IS_SOURCE = 1 << 14;
export const FLAG_HAS_BLOB = 1 << 15;
export const FLAG_LOWERED = 1 << 16;

export interface Facts {
  word: number;
  kind: "cjs" | "esm" | "json" | "unknown";
  /** ESM with top-level await: wrap as `async function*`. */
  async: boolean;
  /** ESM: `__bat.link` specifiers in link order. */
  imports: string[];
  /** `import("literal")` specifiers. */
  dynamicImports: string[];
  /** `require("literal")` specifiers. */
  requires: string[];
  /** Statically known export names (see module-format.md for CJS rules). */
  exports: string[];
  /** ESM `export * from` sources / CJS wholesale re-exports. */
  reexports: string[];
}

const KINDS = ["unknown", "cjs", "esm", "json"] as const;
const decoder = new TextDecoder();

export function kindOf(word: number): Facts["kind"] {
  return KINDS[word & 7] ?? "unknown";
}

/** Decode a facts word and its blob (five lists of LEB128-length-prefixed UTF-8 strings). */
export function decodeFacts(word: number, blob?: Uint8Array): Facts {
  const lists: string[][] = [[], [], [], [], []];
  if (word & FLAG_HAS_BLOB && blob && blob.length > 0) {
    let pos = 0;
    const varint = (): number => {
      let value = 0;
      let shift = 0;
      for (;;) {
        const byte = blob[pos++];
        value |= (byte & 0x7f) << shift;
        if (!(byte & 0x80)) return value >>> 0;
        shift += 7;
      }
    };
    for (const list of lists) {
      const count = varint();
      for (let i = 0; i < count; i++) {
        const length = varint();
        list.push(decoder.decode(blob.subarray(pos, pos + length)));
        pos += length;
      }
    }
  }
  return {
    word,
    kind: kindOf(word),
    async: (word & FLAG_ASYNC) !== 0,
    imports: lists[0],
    dynamicImports: lists[1],
    requires: lists[2],
    exports: lists[3],
    reexports: lists[4],
  };
}
