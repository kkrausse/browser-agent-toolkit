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
         │ original bodies, index order │   each starts on a body-alignment boundary
         │ compiled bodies, index order │
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
(`image-<first 16 hex of sha256>.batimg`), checked once after download.

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
| 44 | 4 | reserved | `0` | | |

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

## Facts word

`0` means the module transform did not look at the entry. Bits 0..7 are defined here; bits
8..31 belong to `bat-modules` (see that crate) and are copied through unchanged.

| Bit | Name | Meaning |
| --- | --- | --- |
| 0 | `KNOWN` | prepare ran the module transform (or classified the file) |
| 1 | `ESM` | source is an ES module; clear = CommonJS |
| 2 | `TLA` | has top-level await: the compiled body is an async function |
| 3 | `JSON` | JSON module: no compiled body, the loader parses the original |
| 4 | `FAILED` | transform failed: no compiled body, the loader transforms at run time |
| 5 | `IN_PROGRAM` | the compiled body is also in a program script (below) |

## Sections

Section table record (24 bytes): `id u32`, `flags u32` (0), `offset u64`, `len u64`,
offsets absolute in the file. The current writer places every payload inside the head, so
`Image::section_bytes(id)` returns it without I/O; a payload at `offset ≥ head_len` is
legal and is read through the positioned read.

| Id | Name | Payload |
| --- | --- | --- |
| 1 | resolution table | reserved; not yet written |
| 2 | program scripts | see below |
| 3 | meta | UTF-8 JSON, informational |

