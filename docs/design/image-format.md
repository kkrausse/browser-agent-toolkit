# Image format (`bat-image`), version 1

One immutable file holding a directory tree: header, index, bodies. Written by the native
writer in `crates/bat-image/src/writer.rs` (driven by `bat-prepare`), read by
`crates/bat-image/src/reader.rs` (`no_std`, no allocation, used inside the kernel).

All integers are little-endian. Nothing in the head is assumed to be aligned in memory:
the reader uses byte-wise loads.

```
offset 0 ┌──────────────────────────────┐
         │ header            128 bytes  │
         │ entry table   N × 48 bytes   │   sorted, see "Order"
         │ string pool                  │   paths and symlink targets, no terminators
         │ section table  S × 24 bytes  │   (8-aligned)
         │ in-head section payloads     │   (each 8-aligned)
head_len ├──────────────────────────────┤   = bodies_off, a multiple of the body alignment
         │ start-up bodies and records  │   optional: what `--order` names, in that order
         │ original bodies, index order │   each starts on a body-alignment boundary
         │ module records, index order  │   compiled body immediately followed by facts blob
file_len └──────────────────────────────┘
```

The **head** is bytes `[0, head_len)`. Mounting is: read 128 bytes, take `head_len`, read
the head into memory once, validate the header fields against `head_len`. No entry is
touched at mount. Everything else is a positioned read of `len` bytes at `offset`.

## Header (128 bytes)

| Offset | Size | Field | Meaning |
| --- | --- | --- | --- |
| 0 | 8 | `magic` | `42 41 54 49 4D 47 0D 0A` (`"BATIMG\r\n"`) |
| 8 | 4 | `version` | `1` |
| 12 | 4 | `header_len` | `128` |
| 16 | 8 | `head_len` | length of the head in bytes |
| 24 | 8 | `file_len` | length of the whole file |
| 32 | 4 | `entry_count` | N ≥ 1 (entry 0 is the root directory) |
| 36 | 4 | `entry_size` | `48` |
| 40 | 8 | `entries_off` | file offset of the entry table (`128`) |
| 48 | 8 | `strings_off` | file offset of the string pool |
| 56 | 8 | `strings_len` | length of the string pool |
| 64 | 8 | `sections_off` | file offset of the section table |
| 72 | 4 | `section_count` | S |
| 76 | 4 | `body_align_log2` | bodies start at multiples of `1 << body_align_log2` (writer default 4 → 16 bytes; ≤ 20) |
| 80 | 8 | `bodies_off` | file offset of the first body, ≥ `head_len` |
| 88 | 8 | `flags` | reserved, `0` |
| 96 | 8 | `head_checksum` | FNV-1a 64 of the head with bytes 96..104 taken as zero |
| 104 | 8 | `mtime` | seconds since the epoch; reported as the mtime of every entry |
| 112 | 16 | reserved | `0` |

A reader rejects: wrong magic, `version != 1`, `header_len != 128`, `entry_size != 48`,
`entry_count == 0`, `body_align_log2 > 20`, any of the entry table / string pool / section
table extending past `head_len`, `bodies_off < head_len`, `file_len < bodies_off`.

The checksum is **not** verified at mount (it is O(head)); `Image::verify_checksum` exists
for tools. Whole-file identity is the content-addressed file name
(`image-<first 16 hex of sha256>.batimg`). A browser verifies a download block by block
against `<image>.sums` before writing it (see "Transfer copy, sums, start-up order").

## Entry (48 bytes)

| Offset | Size | Field | file | dir | symlink |
| --- | --- | --- | --- | --- | --- |
| 0 | 4 | `path_off` | offset of the path in the string pool | same | same |
| 4 | 2 | `path_len` | path length in bytes | same | same |
| 6 | 2 | `name_off` | offset of the last component inside the path | same | same |
| 8 | 1 | `kind` | `0` | `1` | `2` |
| 9 | 1 | reserved | `0` | | |
| 10 | 2 | `mode` | permission bits, `st_mode & 0o7777` | same | `0o777` |
| 12 | 4 | `parent` | index of the parent directory entry (root: 0) | same | same |
| 16 | 8 | `a` | body file offset (0 if empty) | index of first child | target offset in the string pool |
| 24 | 4 | `b` | body length | child count | target length |
| 28 | 4 | `compiled_len` | compiled body length, 0 = none | 0 | 0 |
| 32 | 8 | `compiled_off` | compiled body file offset | 0 | 0 |
| 40 | 4 | `facts` | module facts word | 0 | 0 |
| 44 | 4 | `facts_len` | facts blob length, 0 = none | 0 | 0 |

Paths are relative to the image root, `/`-separated, without leading or trailing slash, no
empty, `.` or `..` components. The root's path is empty. Where the image is mounted in the
guest (`/workspace/node_modules`, `/app`, …) is not part of the image; `bat-prepare`
records it in `manifest.json` and in the meta section. Symlink targets are stored
verbatim (Bun's isolated linker writes relative targets, which stay valid at any mount
point).

Several entries may share string-pool bytes: the writer stores a directory's path as a
prefix of its first child's path.

A body is at most 4 GiB − 1 (`u32` length). Bodies are not compressed and not
checksummed individually.

## Order, lookup, directory listing

Entries are sorted by the pair **(parent path, name)**, each compared bytewise
(`memcmp`, shorter-is-smaller). For a path `p`, the parent path is everything before the
last `/` (empty if none) and the name is everything after it. The root, `("", "")`,
is entry 0.

Consequences the reader relies on:

- **All children of a directory are contiguous** and sorted by name. A directory entry
  stores `[first_child, first_child + child_count)`, so `readdir` is a slice of the entry
  table with kinds available in the same records; no scan.
- **Full-path lookup** is one binary search over the whole table with that comparison
  (`Image::lookup`). It finds only literal paths; it does not follow symlinks.
- **Component walk** (`Image::lookup_child(dir, name)`) is a binary search by name inside
  one child range; this is what symlink-following resolution uses. `parent` gives `..`.
- A parent always precedes its children.

## Module record: compiled body, facts word, facts blob

A file that `bat-prepare` offered to the module transform (`.js .mjs .cjs .jsx .ts .mts
.cts .tsx`, not `.d.ts`; JSON is not offered) carries:

- `facts`: bits 0..23 are the `bat-modules` facts word, stored verbatim (module kind in
  bits 0..2: 1 CommonJS, 2 ESM; bit 3 async/top-level await; bit 14 `CODE_IS_SOURCE`; bit
  15 `HAS_BLOB`; full list in `crates/bat-modules/src/facts.rs` and
  `docs/design/module-format.md`). `facts == 0` means the entry was not offered to the
  transform.
- bits set by `bat-prepare`: **bit 30 `FAILED`** (the transform reported an error; no
  compiled body, no blob; the loader transforms the original at run time and surfaces the
  real diagnostic) and **bit 31 `IN_PROGRAM`** (the compiled body is not in the image
  because it ships in a program script; facts and blob are still here).
- the **module record** at `compiled_off`: `compiled_len` bytes of compiled body (the
  loader-format function *body*, UTF-8) immediately followed by `facts_len` bytes of facts
  blob (import/export lists in the `bat-modules` encoding). One read of
  `compiled_len + facts_len` bytes at `compiled_off` returns both
  (`Entry::module_record`). Either part may be empty; when both are, `compiled_off` is 0.

When `CODE_IS_SOURCE` is set the compiled body equals the original byte for byte and is
not stored a second time (`compiled_len == 0`): the loader uses the original body. So the
rule for the loader is:

```
facts == 0 or FAILED            → transform the original at run time
IN_PROGRAM and script loaded    → function registered by the program script
compiled_len != 0               → compiled body from the image
CODE_IS_SOURCE                  → original body is the function body
otherwise                       → transform the original at run time
```

The function header is not stored; it follows from the facts word (see
`bat-modules`): `function(exports,require,module,__filename,__dirname,__bat){` for
CommonJS, `function*(__bat){` for ESM, `async function*(__bat){` for ESM with bit 3.

## Sections

Section table record (24 bytes): `id u32`, `flags u32` (0), `offset u64`, `len u64`,
offsets absolute in the file. The current writer places every payload inside the head, so
`Image::section_bytes(id)` returns it without I/O; a payload at `offset ≥ head_len` is
legal and is read through the positioned read.

| Id | Name | Payload |
| --- | --- | --- |
| 1 | resolution table | reserved; not written yet |
| 2 | program scripts | UTF-8 JSON: `[{"name": "opencode-server", "modules": ["/app/server.js"]}]`, guest paths in registration order. File names of the scripts are content-addressed and therefore live in `manifest.json`, not in the image. |
| 3 | meta | UTF-8 JSON, informational: `{"tool", "transform", "mount"}` (nothing that varies between builds of equal inputs) |

## Reader API (`bat_image`, `default-features = false` in the kernel)

```rust
Image::head_len(prefix: &[u8]) -> Result<u64, ImageError>   // from the first 128 bytes
Image::new(head: &'a [u8]) -> Result<Image<'a>, ImageError> // mount; O(1); Image is Copy
image.verify_checksum()                                      // optional, O(head)
image.len() / file_len() / mtime() / body_align()
image.entry(i) -> Entry { index, path, name, kind, mode, parent, facts, .. }
entry.size() / body() / compiled() / facts_blob() / module_record() -> Option<Extent{offset,len}>
entry.children() -> Range<u32>      entry.target() -> Option<&[u8]>
image.lookup(path) -> Option<u32>                 // literal path, one binary search
image.lookup_child(dir, name) -> Option<u32>      // one component
image.children(dir) -> Range<u32>   image.read_dir(dir) -> impl Iterator<Item = Entry>
image.resolve(dir, path, follow_final) -> Option<u32>  // follows in-image symlinks, `.`/`..`
image.read_extent(extent, buf, |offset, dst| ...) / read_body(i, ..) / read_compiled(i, ..)
image.section(id) -> Option<Section>   image.section_bytes(id) -> Option<&[u8]>
```

The head slice may live in shared memory; the reader never writes to it and holds no
other state. `read_*` call the supplied function exactly once with the destination slice.

## Program scripts

A program script is a classic script (loadable with `importScripts`, compiled off-thread
and code-cached by the browser) at a content-addressed name
`program-<name>-<first 16 hex of sha256>.js`. For each module, in order:

```js
__bat_define("/app/server.js",async function*(__bat){<compiled body>
});
```

- `__bat_define(path, fn)` is a global the loader installs before loading the script. It
  records `fn` as the module function for the guest absolute path `path`. Nothing runs
  at registration.
- `fn` is exactly the function the loader would have built from the image's compiled
  body: header chosen from the facts word as above, the body starting on the same line
  as the header (so line numbers equal the compiled body's), a newline, `}`.
- Facts and blob for the module are read from the image entry as for any other module;
  the entry has `IN_PROGRAM` set and no compiled body. If the script is not loaded the
  loader falls back to transforming the original, so programs are purely an optimisation.
- Which launch uses which program: `manifest.json`, `launch.<name>.programs`.

## Transfer copy, sums, start-up order

Beside every image (and nothing of this is inside it, so it does not change its hash):

- **`<image>.zst`**: the image as one zstd frame (level 9 by default, `--zstd-level` up to
  19: window ≤ 8 MiB, which is what browsers accept for `Content-Encoding: zstd`; content
  size and checksum in the frame). The server handler answers a request for `<image>` with
  it when the client accepts zstd. Program scripts, the derived bundle and the runtime's
  files get a `.zst` the same way. TODO image: 238.9 MB → 32.2 MB at level 9 (29.0 MB at
  19, 47 s on a busy machine instead of 2 s).
- **`<image>.sums`**: SHA-256 of every 1 MiB block of the image (the last one short),
  32 bytes each, concatenated. The manifest carries the file's own SHA-256. The browser
  hashes each block of a download with WebCrypto and compares before it writes the block.
- **Start-up order** (`bat-prepare app --order <file>`; lines `<b|c|bc>\t<guest path>`,
  from `bat-prepare order <image> <reads.json>`): the named original bodies (`b`) and
  module records (`c`) are laid out directly after the head, in file order; everything
  else follows as before. Where they end is `image.firstBytes` in the manifest. Body
  order is free in the format (entries carry offsets), so readers are unaffected. The
  order file is an input of the image: changing it changes the hash.

## Layers

`manifest.layers[]` are further images, mounted in order after `manifest.image`, each at
its `mount`. `bat-prepare app` writes one when the dependency tree has packages that are
not from the lockfile (workspace members linked with `workspace:`, `file:` directories):
their store entries are moved from `node_modules/.bun/<id>` to `node_modules/.linked/<id>`
(links re-pointed both ways) and that directory is packed as its own image, mounted at
`<workspace>/node_modules/.linked`. The first image then depends only on the lockfile,
the policy, the pinned application and the start-up order.

## Prepared output directory (`bat-prepare app`)

```
<out>/manifest.json
<out>/image-<hash16>.batimg          (+ .zst, .sums; one more set per layer)
<out>/program-<name>-<hash16>.js
<out>.work/            scratch + cache (state.json, staged tree); not served
```

The single image is mounted at `/` and contains `/workspace/node_modules/…` (guest
dependency tree), `/app/server.js` + tree-sitter wasm (pinned, verified) and
`/app/node_modules/…` (ripgrep). Editable source is not in the image: it is in the
manifest and is installed into the overlay.

`manifest.json`:

```jsonc
{
  "format": "bat-prepared-v1",
  "image": { "file": "image-86a0af33366510f8.batimg", "bytes": 243425648, "sha256": "…",
             "mount": "/", "entries": 12110, "headBytes": 1726208, "firstBytes": 13518912,
             "zstd": { "file": "image-….batimg.zst", "bytes": 32232366, "level": 9 },
             "sums": { "file": "image-….batimg.sums", "blockBytes": 1048576, "sha256": "…" } },
  "layers": [ { "file": "image-….batimg", "mount": "/workspace/node_modules/.linked", … } ],
  "programs": [ { "name": "opencode-server", "file": "program-opencode-server-….js",
                  "bytes": 27721261, "sha256": "…", "modules": ["/app/server.js"] } ],
  "launch": {
    "preview": { "entry": "/workspace/node_modules/vite/bin/vite.js", "args": ["--configLoader", "native", "--host", "0.0.0.0", "--port", "5173", "--strictPort"],
                 "cwd": "/workspace", "env": { … }, "port": 5173, "programs": [] },
    "agent":   { "entry": "/app/server.js", "args": [], "cwd": "/app", "env": { … },
                 "port": 4096, "programs": ["opencode-server"] }
  },
  "workspace": "/workspace",
  "source": ["src", "vite.config.ts", …],          // the editable allowlist, app-relative
  "project": {                                      // workspace-relative path → content
    "/src/root.tsx": "…utf-8 text…",
    "/public/logo.png": { "encoding": "base64", "data": "…" },
    "/package.json": "…", "/bun.lock": "…"
  },
  "application": { "id": "opencode-server-process-2.0.3", "directory": "/app", "files": { "server.js": { "bytes", "sha256" }, … } },
  "dependencies": { "installer", "before", "after", "substitutions", "removedPackages", … }
}
```

`launch.agent.env` carries no secret; the host adds `OPENCODE_PASSWORD` and writes the
OpenCode config at run time. `launch.*.programs` lists only scripts that were emitted.

## Guest policy (`crates/bat-prepare/data/guest-policy.json`)

Data that decides the guest tree; `--policy <file>` replaces it, `bat-prepare policy`
prints the embedded one.

- `substitutions[]`: `{ "package", "with", "expect" }`. If `package` is locked (one
  version), a root `overrides` entry is added with `with` after replacing `{version}`.
  `with` is `npm:<name>@{version}`, a tarball URL, or **`dir:<path>`** (a local package
  directory relative to the policy file, copied into the stage and installed as a `file:`
  dependency: this is how a Rust-backed shim package replaces an entry). `expect` is a
  file that must exist in the installed replacement.
- `prune`: `packages` (names, trailing `*`), `nativePackages` (drop packages whose
  package.json restricts `os`/`cpu`, unless `cpu` includes `wasm32`), `extensions`
  (file suffixes), `paths` (globs relative to `node_modules`), `duplicatesOfApplication`
  (drop files byte-identical to an application file). Dangling symlinks and emptied
  directories are removed afterwards.
- `application`: guest directory, pinned files (`bytes`, `sha256`), and the `support`
  install (manifest + lock for `ripgrep@0.3.1`, placed at `/app/node_modules`).
- `programs[]`: `{ "name", "modules": [guest paths] }`.
- `launch`: copied into the manifest (`--preview '<json>'` is merged over `launch.preview`).
