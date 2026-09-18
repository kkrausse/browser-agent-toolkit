export type ManagedEntry =
  | { kind: "file"; destination: string; mode: number; file: string; bytes: number; sha256: string }
  | { kind: "directory"; destination: string; mode: number }
  | { kind: "symlink"; destination: string; target: string };

export type ManagedBundle = { file: string; bytes: number; sha256: string };

/** A managed delivery replaces exactly its declared roots when installed. */
export type ManagedDelivery = {
  format: "managed-tree-v1";
  roots: string[];
  entries: ManagedEntry[];
  bundle: ManagedBundle;
};

export type SourceFile = string | { encoding: "base64"; data: string };
export type SourceDelivery = Record<string, SourceFile>;
