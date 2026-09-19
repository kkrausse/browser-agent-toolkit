export type ManagedEntry =
  | { kind: "file"; destination: string; mode: number; file: string; bytes: number; sha256: string }
  | { kind: "directory"; destination: string; mode: number }
  | { kind: "symlink"; destination: string; target: string };

export type ManagedBundle = { file: string; bytes: number; sha256: string };
export type ManagedVfsImage = ManagedBundle & { format: "managed-vfs-image-v1" };

/** A managed delivery replaces exactly its declared roots when installed. */
export type ManagedDelivery = {
  format: "managed-tree-v1";
  roots: string[];
  entries: ManagedEntry[];
  bundle: ManagedBundle;
  /** Optional fresh-load image carrying the VFS's retained raw/zlib file bodies. */
  image?: ManagedVfsImage;
};

export type SourceFile = string | { encoding: "base64"; data: string };
export type SourceDelivery = Record<string, SourceFile>;
