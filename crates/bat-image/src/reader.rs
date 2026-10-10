use core::cmp::Ordering;
use core::ops::Range;

pub const MAGIC: [u8; 8] = *b"BATIMG\r\n";
pub const VERSION: u32 = 1;
/// Size of the fixed header. Read this many bytes first to learn `head_len`.
pub const HEADER_LEN: usize = 128;
pub const ENTRY_SIZE: usize = 48;
pub const SECTION_SIZE: usize = 24;

pub const KIND_FILE: u8 = 0;
pub const KIND_DIR: u8 = 1;
pub const KIND_SYMLINK: u8 = 2;

/// Section ids. Payload formats are documented in `docs/design/image-format.md`.
pub const SECTION_RESOLUTION: u32 = 1;
pub const SECTION_PROGRAMS: u32 = 2;
pub const SECTION_META: u32 = 3;

/// Facts word. Bits 0..=23 are defined by `bat-modules` (module kind in bits 0..=2,
/// zero = the transform did not classify the entry; see `docs/design/module-format.md`)
/// and are stored verbatim. The top bits are set by `bat-prepare`.
pub mod facts {
    /// Mask of the bits owned by `bat-modules`.
    pub const MODULE_MASK: u32 = 0x00ff_ffff;
    /// The transform was attempted and failed; the loader transforms at run time.
    pub const FAILED: u32 = 1 << 30;
    /// The compiled body lives in a program script, not in the image (section 2
    /// names the script). Without the script the loader transforms at run time.
    pub const IN_PROGRAM: u32 = 1 << 31;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageError {
    /// Fewer bytes than the header (or than `head_len`) were supplied.
    Truncated,
    BadMagic,
    BadVersion,
    /// A header field points outside the head or is inconsistent.
    Corrupt,
    ChecksumMismatch,
    /// Entry is not a regular file / has no compiled body.
    NoBody,
    /// Destination buffer is smaller than the body.
    BufferTooSmall,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
    Symlink,
}

/// Location of a body in the image file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Extent {
    pub offset: u64,
    pub len: u32,
}

/// Decoded index entry. Cheap to produce (a handful of unaligned loads).
#[derive(Debug, Clone, Copy)]
pub struct Entry<'a> {
    pub index: u32,
    /// Path relative to the image root, no leading or trailing slash; root is `""`.
    pub path: &'a [u8],
    /// Final path component (a sub-slice of `path`).
    pub name: &'a [u8],
    pub kind: Kind,
    /// Permission bits (`st_mode & 0o7777`).
    pub mode: u16,
    /// Index of the parent directory (root's parent is itself, 0).
    pub parent: u32,
    a: u64,
    b: u32,
    compiled_off: u64,
    compiled_len: u32,
    /// Module facts, see [`facts`].
    pub facts: u32,
    facts_len: u32,
    target: &'a [u8],
}

impl<'a> Entry<'a> {
    pub fn is_file(&self) -> bool {
        self.kind == Kind::File
    }
    pub fn is_dir(&self) -> bool {
        self.kind == Kind::Dir
    }
    pub fn is_symlink(&self) -> bool {
        self.kind == Kind::Symlink
    }
    /// `st_size`: body length for files, target length for symlinks, 0 for directories.
    pub fn size(&self) -> u64 {
        match self.kind {
            Kind::File | Kind::Symlink => self.b as u64,
            Kind::Dir => 0,
        }
    }
    /// Extent of the original body (files only).
    pub fn body(&self) -> Option<Extent> {
        (self.kind == Kind::File).then_some(Extent { offset: self.a, len: self.b })
    }
    /// Extent of the precompiled module body, if the entry has one.
    pub fn compiled(&self) -> Option<Extent> {
        (self.kind == Kind::File && self.compiled_len != 0)
            .then_some(Extent { offset: self.compiled_off, len: self.compiled_len })
    }
    /// Extent of the facts blob (import/export lists, format owned by `bat-modules`),
    /// if any. It is stored directly after the compiled body.
    pub fn facts_blob(&self) -> Option<Extent> {
        (self.kind == Kind::File && self.facts_len != 0)
            .then_some(Extent { offset: self.compiled_off + self.compiled_len as u64, len: self.facts_len })
    }
    /// Compiled body and facts blob as one extent, so one read returns both: the
    /// first `compiled().len` bytes are code, the rest is the blob.
    pub fn module_record(&self) -> Option<Extent> {
        let len = self.compiled_len.checked_add(self.facts_len)?;
        (self.kind == Kind::File && len != 0).then_some(Extent { offset: self.compiled_off, len })
    }
    /// Indices of this directory's children (sorted by name). Empty for non-directories.
    pub fn children(&self) -> Range<u32> {
        match self.kind {
            Kind::Dir => (self.a as u32)..(self.a as u32 + self.b),
            _ => 0..0,
        }
    }
    /// Symlink target exactly as stored (may be relative or absolute).
    pub fn target(&self) -> Option<&'a [u8]> {
        (self.kind == Kind::Symlink).then_some(self.target)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Section {
    pub id: u32,
    pub flags: u32,
    pub offset: u64,
    pub len: u64,
}

/// A mounted image: a validated view over the head bytes. `Copy`, no allocation.
#[derive(Debug, Clone, Copy)]
pub struct Image<'a> {
    head: &'a [u8],
    entries_off: usize,
    entry_count: u32,
    strings_off: usize,
    strings_len: usize,
    sections_off: usize,
    section_count: u32,
    file_len: u64,
    bodies_off: u64,
    body_align: u32,
}

#[inline]
fn u16_at(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
#[inline]
fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
#[inline]
fn u64_at(b: &[u8], o: usize) -> u64 {
    let mut x = [0u8; 8];
    x.copy_from_slice(&b[o..o + 8]);
    u64::from_le_bytes(x)
}

/// FNV-1a 64 over the head with the checksum field (bytes 96..104) treated as zero.
pub fn head_checksum(head: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for (i, &byte) in head.iter().enumerate() {
        let byte = if (96..104).contains(&i) { 0 } else { byte };
        h ^= byte as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Split a relative path into (parent, name). `"a/b/c"` → `("a/b", "c")`, `"a"` → `("", "a")`.
#[inline]
pub fn split_path(path: &[u8]) -> (&[u8], &[u8]) {
    match path.iter().rposition(|&c| c == b'/') {
        Some(i) => (&path[..i], &path[i + 1..]),
        None => (&path[..0], path),
    }
}

/// The index order: by parent path, then by name, both bytewise. The root (`""`)
/// sorts first. All children of one directory are therefore contiguous.
#[inline]
pub fn compare_paths(a: &[u8], b: &[u8]) -> Ordering {
    let (ap, an) = split_path(a);
    let (bp, bn) = split_path(b);
    ap.cmp(bp).then_with(|| an.cmp(bn))
}

impl<'a> Image<'a> {
    /// Given at least the first [`HEADER_LEN`] bytes of the file, return how many bytes
    /// from offset 0 make up the head that [`Image::new`] needs.
    pub fn head_len(prefix: &[u8]) -> Result<u64, ImageError> {
        if prefix.len() < HEADER_LEN {
            return Err(ImageError::Truncated);
        }
        if prefix[..8] != MAGIC {
            return Err(ImageError::BadMagic);
        }
        if u32_at(prefix, 8) != VERSION {
            return Err(ImageError::BadVersion);
        }
        Ok(u64_at(prefix, 16))
    }

    /// Mount: validate the header and keep the head. O(1); no per-entry work.
    /// `head` must be at least `head_len` bytes starting at file offset 0 (extra is ignored).
    pub fn new(head: &'a [u8]) -> Result<Self, ImageError> {
        let head_len = Self::head_len(head)?;
        if (head.len() as u64) < head_len {
            return Err(ImageError::Truncated);
        }
        let head = &head[..head_len as usize];
        let hl = head.len() as u64;
        if u32_at(head, 12) as usize != HEADER_LEN || u32_at(head, 36) as usize != ENTRY_SIZE {
            return Err(ImageError::Corrupt);
        }
        let file_len = u64_at(head, 24);
        let entry_count = u32_at(head, 32);
        let entries_off = u64_at(head, 40);
        let strings_off = u64_at(head, 48);
        let strings_len = u64_at(head, 56);
        let sections_off = u64_at(head, 64);
        let section_count = u32_at(head, 72);
        let align_log2 = u32_at(head, 76);
        let bodies_off = u64_at(head, 80);
        let within = |off: u64, len: u64| off.checked_add(len).is_some_and(|end| end <= hl);
        if entry_count == 0
            || align_log2 > 20
            || !within(entries_off, entry_count as u64 * ENTRY_SIZE as u64)
            || !within(strings_off, strings_len)
            || !within(sections_off, section_count as u64 * SECTION_SIZE as u64)
            || bodies_off < hl
            || file_len < bodies_off
        {
            return Err(ImageError::Corrupt);
        }
        Ok(Image {
            head,
            entries_off: entries_off as usize,
            entry_count,
            strings_off: strings_off as usize,
            strings_len: strings_len as usize,
            sections_off: sections_off as usize,
            section_count,
            file_len,
            bodies_off,
            body_align: 1 << align_log2,
        })
    }

    /// Optional integrity check of the head, O(head_len). Not part of mount.
    pub fn verify_checksum(&self) -> Result<(), ImageError> {
        if head_checksum(self.head) == u64_at(self.head, 96) {
            Ok(())
        } else {
            Err(ImageError::ChecksumMismatch)
        }
    }

    pub fn head(&self) -> &'a [u8] {
        self.head
    }
    /// Number of entries, including the root directory at index 0.
    pub fn len(&self) -> u32 {
        self.entry_count
    }
    pub fn is_empty(&self) -> bool {
        self.entry_count <= 1
    }
    /// Total image file length in bytes.
    pub fn file_len(&self) -> u64 {
        self.file_len
    }
    pub fn bodies_offset(&self) -> u64 {
        self.bodies_off
    }
    pub fn body_align(&self) -> u32 {
        self.body_align
    }
    /// Build time (seconds since the epoch); used as mtime for every entry.
    pub fn mtime(&self) -> u64 {
        u64_at(self.head, 104)
    }
    /// Index of the root directory.
    pub const ROOT: u32 = 0;

    #[inline]
    fn string(&self, off: u32, len: usize) -> &'a [u8] {
        let start = self.strings_off + off as usize;
        let end = start + len;
        if end > self.strings_off + self.strings_len {
            return &[];
        }
        &self.head[start..end]
    }

    #[inline]
    fn raw(&self, index: u32) -> &'a [u8] {
        let o = self.entries_off + index as usize * ENTRY_SIZE;
        &self.head[o..o + ENTRY_SIZE]
    }

    #[inline]
    fn path_of(&self, index: u32) -> &'a [u8] {
        let r = self.raw(index);
        self.string(u32_at(r, 0), u16_at(r, 4) as usize)
    }

    /// Decode entry `index`. Panics if `index >= len()`.
    pub fn entry(&self, index: u32) -> Entry<'a> {
        assert!(index < self.entry_count);
        let r = self.raw(index);
        let path = self.string(u32_at(r, 0), u16_at(r, 4) as usize);
        let name_off = (u16_at(r, 6) as usize).min(path.len());
        let kind = match r[8] {
            KIND_DIR => Kind::Dir,
            KIND_SYMLINK => Kind::Symlink,
            _ => Kind::File,
        };
        let a = u64_at(r, 16);
        let b = u32_at(r, 24);
        let target = if kind == Kind::Symlink { self.string(a as u32, b as usize) } else { &[][..] };
        Entry {
            index,
            path,
            name: &path[name_off..],
            kind,
            mode: u16_at(r, 10),
            parent: u32_at(r, 12),
            a,
            b,
            compiled_len: u32_at(r, 28),
            compiled_off: u64_at(r, 32),
            facts: u32_at(r, 40),
            facts_len: u32_at(r, 44),
            target,
        }
    }

    pub fn get(&self, index: u32) -> Option<Entry<'a>> {
        (index < self.entry_count).then(|| self.entry(index))
    }

    /// Exact lookup of a normalised relative path (`"a/b/c"`, root is `""`); one binary
    /// search over the whole index. Does not follow symlinks: a path that crosses a
    /// symlink is not found, and the caller should walk with [`Image::lookup_child`].
    pub fn lookup(&self, path: &[u8]) -> Option<u32> {
        let (mut lo, mut hi) = (0u32, self.entry_count);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            match compare_paths(self.path_of(mid), path) {
                Ordering::Less => lo = mid + 1,
                Ordering::Greater => hi = mid,
                Ordering::Equal => return Some(mid),
            }
        }
        None
    }

    /// Child range of directory `dir` (empty if `dir` is not a directory).
    pub fn children(&self, dir: u32) -> Range<u32> {
        if dir >= self.entry_count {
            return 0..0;
        }
        let r = self.raw(dir);
        if r[8] != KIND_DIR {
            return 0..0;
        }
        let first = u64_at(r, 16) as u32;
        let count = u32_at(r, 24);
        match first.checked_add(count) {
            Some(end) if end <= self.entry_count => first..end,
            _ => 0..0,
        }
    }

    /// Name of entry `index` without decoding the rest.
    pub fn name(&self, index: u32) -> &'a [u8] {
        let r = self.raw(index);
        let path = self.string(u32_at(r, 0), u16_at(r, 4) as usize);
        &path[(u16_at(r, 6) as usize).min(path.len())..]
    }

    /// Find `name` among the children of `dir`: binary search within the child range.
    pub fn lookup_child(&self, dir: u32, name: &[u8]) -> Option<u32> {
        let Range { start: mut lo, end: mut hi } = self.children(dir);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            match self.name(mid).cmp(name) {
                Ordering::Less => lo = mid + 1,
                Ordering::Greater => hi = mid,
                Ordering::Equal => return Some(mid),
            }
        }
        None
    }

    /// Resolve `path` relative to directory `dir`, following symlinks inside the image
    /// (`.` and `..` are honoured; `..` at the root stays at the root). The final
    /// component is followed only if `follow_final`. Returns `None` if a component is
    /// missing, a symlink target is absolute (the image does not know its mount point;
    /// the caller resolves those), or more than 40 links are crossed.
    /// Allocation-free: nested links recurse.
    pub fn resolve(&self, dir: u32, path: &[u8], follow_final: bool) -> Option<u32> {
        self.resolve_depth(dir, path, follow_final, 0)
    }

    fn resolve_depth(&self, dir: u32, path: &[u8], follow_final: bool, depth: u32) -> Option<u32> {
        if depth > 40 || dir >= self.entry_count || path.first() == Some(&b'/') {
            return None;
        }
        let mut at = dir;
        let mut rest = path;
        while !rest.is_empty() {
            let (part, tail) = match rest.iter().position(|&c| c == b'/') {
                Some(i) => (&rest[..i], &rest[i + 1..]),
                None => (rest, &rest[rest.len()..]),
            };
            rest = tail;
            if part.is_empty() || part == b"." {
                continue;
            }
            let r = self.raw(at);
            if r[8] != KIND_DIR {
                return None;
            }
            if part == b".." {
                at = u32_at(r, 12);
                continue;
            }
            let child = self.lookup_child(at, part)?;
            let c = self.raw(child);
            let last = rest.iter().all(|&b| b == b'/');
            if c[8] == KIND_SYMLINK && (follow_final || !last) {
                let target = self.string(u64_at(c, 16) as u32, u32_at(c, 24) as usize);
                at = self.resolve_depth(at, target, true, depth + 1)?;
            } else {
                at = child;
            }
        }
        Some(at)
    }

    /// Iterate a directory's children in name order.
    pub fn read_dir(&self, dir: u32) -> impl Iterator<Item = Entry<'a>> + 'a {
        let image = *self;
        self.children(dir).map(move |i| image.entry(i))
    }

    pub fn section_count(&self) -> u32 {
        self.section_count
    }

    pub fn section_at(&self, i: u32) -> Section {
        let o = self.sections_off + i as usize * SECTION_SIZE;
        let r = &self.head[o..o + SECTION_SIZE];
        Section { id: u32_at(r, 0), flags: u32_at(r, 4), offset: u64_at(r, 8), len: u64_at(r, 16) }
    }

    pub fn section(&self, id: u32) -> Option<Section> {
        (0..self.section_count).map(|i| self.section_at(i)).find(|s| s.id == id)
    }

    /// Bytes of a section stored inside the head. `None` if absent or stored after the
    /// bodies (then read `Section::offset/len` through the positioned read).
    pub fn section_bytes(&self, id: u32) -> Option<&'a [u8]> {
        let s = self.section(id)?;
        let end = s.offset.checked_add(s.len)?;
        (end <= self.head.len() as u64).then(|| &self.head[s.offset as usize..end as usize])
    }

    /// Read one extent with a single call to `read_at(offset, dst)`, which must fill
    /// `dst` completely from the image file at `offset`. Returns the filled prefix of `buf`.
    pub fn read_extent<'b, E>(
        &self,
        extent: Extent,
        buf: &'b mut [u8],
        read_at: impl FnOnce(u64, &mut [u8]) -> Result<(), E>,
    ) -> Result<&'b [u8], ReadError<E>> {
        let len = extent.len as usize;
        if buf.len() < len {
            return Err(ReadError::Image(ImageError::BufferTooSmall));
        }
        if extent.offset.checked_add(len as u64).is_none_or(|end| end > self.file_len) {
            return Err(ReadError::Image(ImageError::Corrupt));
        }
        if len != 0 {
            read_at(extent.offset, &mut buf[..len]).map_err(ReadError::Io)?;
        }
        Ok(&buf[..len])
    }

    /// Read the original body of file entry `index` into `buf`.
    pub fn read_body<'b, E>(
        &self,
        index: u32,
        buf: &'b mut [u8],
        read_at: impl FnOnce(u64, &mut [u8]) -> Result<(), E>,
    ) -> Result<&'b [u8], ReadError<E>> {
        let extent = self.entry(index).body().ok_or(ReadError::Image(ImageError::NoBody))?;
        self.read_extent(extent, buf, read_at)
    }

    /// Read the compiled body of file entry `index` into `buf`.
    pub fn read_compiled<'b, E>(
        &self,
        index: u32,
        buf: &'b mut [u8],
        read_at: impl FnOnce(u64, &mut [u8]) -> Result<(), E>,
    ) -> Result<&'b [u8], ReadError<E>> {
        let extent = self.entry(index).compiled().ok_or(ReadError::Image(ImageError::NoBody))?;
        self.read_extent(extent, buf, read_at)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadError<E> {
    Image(ImageError),
    Io(E),
}
