//! Native writer. Two steps so that bodies can be produced and written in parallel:
//! [`Builder::plan`] lays the image out from sizes alone and returns the finished head
//! plus the extent of every body; the caller then writes the head at offset 0 and each
//! body at its extent (`pwrite`), in any order.

use crate::reader::*;
use std::collections::HashMap;
use std::fmt;
use std::fs::File;
use std::io;
use std::os::unix::fs::FileExt;
use std::path::Path;

#[derive(Debug)]
pub enum BuildError {
    DuplicatePath(String),
    /// A path component is empty, `.` or `..`, or the path is absolute.
    InvalidPath(String),
    PathTooLong(String),
    FileTooLarge(String),
    /// The parent of an entry exists but is not a directory.
    ParentNotDir(String),
    TooLarge,
}

impl fmt::Display for BuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for BuildError {}

#[derive(Debug, Clone)]
enum Node {
    File { len: u32, compiled_len: u32, facts: u32, facts_len: u32 },
    Dir,
    Symlink { target: Vec<u8> },
}

#[derive(Debug, Clone)]
struct Pending {
    path: Vec<u8>,
    mode: u16,
    node: Node,
}

/// Handle returned by [`Builder::file`]; indexes [`Plan::files`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct FileId(pub usize);

pub struct Builder {
    entries: Vec<Pending>,
    by_path: HashMap<Vec<u8>, usize>,
    files: Vec<usize>,
    sections: Vec<(u32, u32, Vec<u8>)>,
    align_log2: u32,
    mtime: u64,
}

/// Where the bodies of one file go.
#[derive(Debug, Clone, Copy)]
pub struct FileExtents {
    pub body: Extent,
    pub compiled: Option<Extent>,
    /// Directly follows the compiled body.
    pub facts_blob: Option<Extent>,
    /// Index of the entry in the finished image.
    pub index: u32,
}

pub struct Plan {
    /// Bytes to write at file offset 0.
    pub head: Vec<u8>,
    pub file_len: u64,
    /// One per [`Builder::file`] call, in call order.
    pub files: Vec<FileExtents>,
}

fn check_path(path: &str) -> Result<(), BuildError> {
    if path.is_empty() || path.split('/').any(|c| c.is_empty() || c == "." || c == "..") {
        return Err(BuildError::InvalidPath(path.to_string()));
    }
    if path.len() > u16::MAX as usize {
        return Err(BuildError::PathTooLong(path.to_string()));
    }
    Ok(())
}

impl Default for Builder {
    fn default() -> Self {
        Self::new()
    }
}

impl Builder {
    pub fn new() -> Self {
        let mut b = Builder {
            entries: Vec::new(),
            by_path: HashMap::new(),
            files: Vec::new(),
            sections: Vec::new(),
            align_log2: 4,
            mtime: 0,
        };
        b.entries.push(Pending { path: Vec::new(), mode: 0o755, node: Node::Dir });
        b.by_path.insert(Vec::new(), 0);
        b
    }

    /// Body alignment as a power of two (default 4 → 16 bytes).
    pub fn align_log2(&mut self, log2: u32) -> &mut Self {
        self.align_log2 = log2.min(20);
        self
    }

    /// Timestamp reported as every entry's mtime. Keep it fixed for reproducible images.
    pub fn mtime(&mut self, secs: u64) -> &mut Self {
        self.mtime = secs;
        self
    }

    fn add(&mut self, path: &str, mode: u16, node: Node) -> Result<usize, BuildError> {
        check_path(path)?;
        let key = path.as_bytes().to_vec();
        if let Some(&existing) = self.by_path.get(&key) {
            // An explicit directory may follow its implicit creation by a child.
            if matches!((&self.entries[existing].node, &node), (Node::Dir, Node::Dir)) {
                self.entries[existing].mode = mode;
                return Ok(existing);
            }
            return Err(BuildError::DuplicatePath(path.to_string()));
        }
        let i = self.entries.len();
        self.entries.push(Pending { path: key.clone(), mode, node });
        self.by_path.insert(key, i);
        Ok(i)
    }

    /// Add a regular file of `len` bytes. Paths are relative to the image root, `/`-separated.
    pub fn file(&mut self, path: &str, mode: u16, len: u64) -> Result<FileId, BuildError> {
        let len = u32::try_from(len).map_err(|_| BuildError::FileTooLarge(path.to_string()))?;
        let i = self.add(path, mode, Node::File { len, compiled_len: 0, facts: 0, facts_len: 0 })?;
        self.files.push(i);
        Ok(FileId(self.files.len() - 1))
    }

    /// Record the module record of a file: compiled body length (0 for none), the facts
    /// word, and the facts blob length (0 for none).
    pub fn set_module(&mut self, id: FileId, compiled_len: u64, facts: u32, blob_len: u64) -> Result<(), BuildError> {
        let entry = &mut self.entries[self.files[id.0]];
        let too_large = || BuildError::FileTooLarge(String::from_utf8_lossy(&entry.path).into_owned());
        let new_len = u32::try_from(compiled_len).map_err(|_| too_large())?;
        let new_blob = u32::try_from(blob_len).map_err(|_| too_large())?;
        new_len.checked_add(new_blob).ok_or_else(too_large)?;
        if let Node::File { compiled_len, facts: f, facts_len, .. } = &mut entry.node {
            *compiled_len = new_len;
            *f = facts;
            *facts_len = new_blob;
        }
        Ok(())
    }

    pub fn dir(&mut self, path: &str, mode: u16) -> Result<(), BuildError> {
        self.add(path, mode, Node::Dir).map(|_| ())
    }

    pub fn symlink(&mut self, path: &str, target: &str) -> Result<(), BuildError> {
        self.add(path, 0o777, Node::Symlink { target: target.as_bytes().to_vec() }).map(|_| ())
    }

    /// Add an in-head section. One section per id.
    pub fn section(&mut self, id: u32, bytes: Vec<u8>) -> &mut Self {
        self.sections.retain(|s| s.0 != id);
        self.sections.push((id, 0, bytes));
        self
    }

    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    /// Lay the image out. Missing parent directories are created with mode 0755.
    pub fn plan(mut self) -> Result<Plan, BuildError> {
        // Implicit parents.
        let mut i = 0;
        while i < self.entries.len() {
            let path = self.entries[i].path.clone();
            if !path.is_empty() {
                let (parent, _) = split_path(&path);
                match self.by_path.get(parent) {
                    Some(&p) => {
                        if !matches!(self.entries[p].node, Node::Dir) {
                            return Err(BuildError::ParentNotDir(String::from_utf8_lossy(&path).into_owned()));
                        }
                    }
                    None => {
                        let n = self.entries.len();
                        self.entries.push(Pending { path: parent.to_vec(), mode: 0o755, node: Node::Dir });
                        self.by_path.insert(parent.to_vec(), n);
                    }
                }
            }
            i += 1;
        }

        let n = self.entries.len();
        if n > u32::MAX as usize {
            return Err(BuildError::TooLarge);
        }
        let mut order: Vec<usize> = (0..n).collect();
        order.sort_unstable_by(|&a, &b| compare_paths(&self.entries[a].path, &self.entries[b].path));
        let mut new_index = vec![0u32; n];
        for (pos, &old) in order.iter().enumerate() {
            new_index[old] = pos as u32;
        }

        // Parent links and child ranges (children of one directory are contiguous).
        let mut parent = vec![0u32; n];
        let mut first_child = vec![0u32; n];
        let mut child_count = vec![0u32; n];
        for pos in 1..n {
            let path = &self.entries[order[pos]].path;
            let p = new_index[self.by_path[split_path(path).0]] as usize;
            parent[pos] = p as u32;
            if child_count[p] == 0 {
                first_child[p] = pos as u32;
            }
            child_count[p] += 1;
        }

        // String pool. A directory's path is a prefix of its first child's path, so only
        // leaves (and symlink targets) add bytes. Walk backwards: children come after parents.
        let mut strings: Vec<u8> = Vec::new();
        let mut path_off = vec![0u32; n];
        let mut target_off = vec![0u32; n];
        for pos in (0..n).rev() {
            let e = &self.entries[order[pos]];
            if child_count[pos] != 0 {
                path_off[pos] = path_off[first_child[pos] as usize];
            } else {
                path_off[pos] = strings.len() as u32;
                strings.extend_from_slice(&e.path);
            }
            if let Node::Symlink { target } = &e.node {
                target_off[pos] = strings.len() as u32;
                strings.extend_from_slice(target);
            }
            if strings.len() > u32::MAX as usize {
                return Err(BuildError::TooLarge);
            }
        }

        let align = 1u64 << self.align_log2;
        let round = |x: u64| (x + align - 1) & !(align - 1);
        let round8 = |x: u64| (x + 7) & !7;

        let entries_off = HEADER_LEN as u64;
        let strings_off = entries_off + (n * ENTRY_SIZE) as u64;
        let sections_off = round8(strings_off + strings.len() as u64);
        let mut cursor = sections_off + (self.sections.len() * SECTION_SIZE) as u64;
        let mut section_table = Vec::new();
        for (id, flags, bytes) in &self.sections {
            cursor = round8(cursor);
            section_table.push((*id, *flags, cursor, bytes.len() as u64));
            cursor += bytes.len() as u64;
        }
        let head_len = round(cursor);
        let bodies_off = head_len;

        // Bodies: originals in index order, then compiled bodies in index order.
        let mut body_off = vec![0u64; n];
        let mut compiled_off = vec![0u64; n];
        let mut cursor = bodies_off;
        for pos in 0..n {
            if let Node::File { len, .. } = self.entries[order[pos]].node {
                if len != 0 {
                    body_off[pos] = cursor;
                    cursor = round(cursor + len as u64);
                }
            }
        }
        for pos in 0..n {
            if let Node::File { compiled_len, facts_len, .. } = self.entries[order[pos]].node {
                if compiled_len + facts_len != 0 {
                    compiled_off[pos] = cursor;
                    cursor = round(cursor + compiled_len as u64 + facts_len as u64);
                }
            }
        }
        let file_len = cursor;

        let mut head = vec![0u8; head_len as usize];
        head[0..8].copy_from_slice(&MAGIC);
        put32(&mut head, 8, VERSION);
        put32(&mut head, 12, HEADER_LEN as u32);
        put64(&mut head, 16, head_len);
        put64(&mut head, 24, file_len);
        put32(&mut head, 32, n as u32);
        put32(&mut head, 36, ENTRY_SIZE as u32);
        put64(&mut head, 40, entries_off);
        put64(&mut head, 48, strings_off);
        put64(&mut head, 56, strings.len() as u64);
        put64(&mut head, 64, sections_off);
        put32(&mut head, 72, self.sections.len() as u32);
        put32(&mut head, 76, self.align_log2);
        put64(&mut head, 80, bodies_off);
        put64(&mut head, 104, self.mtime);

        for pos in 0..n {
            let e = &self.entries[order[pos]];
            let o = entries_off as usize + pos * ENTRY_SIZE;
            let name_off = e.path.len() - split_path(&e.path).1.len();
            put32(&mut head, o, path_off[pos]);
            put16(&mut head, o + 4, e.path.len() as u16);
            put16(&mut head, o + 6, name_off as u16);
            put16(&mut head, o + 10, e.mode & 0o7777);
            put32(&mut head, o + 12, parent[pos]);
            match &e.node {
                Node::File { len, compiled_len, facts, facts_len } => {
                    head[o + 8] = KIND_FILE;
                    put64(&mut head, o + 16, body_off[pos]);
                    put32(&mut head, o + 24, *len);
                    put32(&mut head, o + 28, *compiled_len);
                    put64(&mut head, o + 32, compiled_off[pos]);
                    put32(&mut head, o + 40, *facts);
                    put32(&mut head, o + 44, *facts_len);
                }
                Node::Dir => {
                    head[o + 8] = KIND_DIR;
                    put64(&mut head, o + 16, first_child[pos] as u64);
                    put32(&mut head, o + 24, child_count[pos]);
                }
                Node::Symlink { target } => {
                    head[o + 8] = KIND_SYMLINK;
                    put64(&mut head, o + 16, target_off[pos] as u64);
                    put32(&mut head, o + 24, target.len() as u32);
                }
            }
        }
        let so = strings_off as usize;
        head[so..so + strings.len()].copy_from_slice(&strings);
        for (i, (id, flags, off, len)) in section_table.iter().enumerate() {
            let o = sections_off as usize + i * SECTION_SIZE;
            put32(&mut head, o, *id);
            put32(&mut head, o + 4, *flags);
            put64(&mut head, o + 8, *off);
            put64(&mut head, o + 16, *len);
            head[*off as usize..(*off + *len) as usize].copy_from_slice(&self.sections[i].2);
        }
        let sum = head_checksum(&head);
        put64(&mut head, 96, sum);

        let files = self
            .files
            .iter()
            .map(|&old| {
                let pos = new_index[old] as usize;
                let Node::File { len, compiled_len, facts_len, .. } = self.entries[old].node else { unreachable!() };
                FileExtents {
                    body: Extent { offset: body_off[pos], len },
                    compiled: (compiled_len != 0).then_some(Extent { offset: compiled_off[pos], len: compiled_len }),
                    facts_blob: (facts_len != 0)
                        .then_some(Extent { offset: compiled_off[pos] + compiled_len as u64, len: facts_len }),
                    index: pos as u32,
                }
            })
            .collect();
        Ok(Plan { head, file_len, files })
    }
}

fn put16(b: &mut [u8], o: usize, v: u16) {
    b[o..o + 2].copy_from_slice(&v.to_le_bytes());
}
fn put32(b: &mut [u8], o: usize, v: u32) {
    b[o..o + 4].copy_from_slice(&v.to_le_bytes());
}
fn put64(b: &mut [u8], o: usize, v: u64) {
    b[o..o + 8].copy_from_slice(&v.to_le_bytes());
}

impl Plan {
    /// Size the file and write the head. Bodies are then written with
    /// `file.write_all_at(bytes, extent.offset)` from any thread.
    pub fn begin(&self, file: &File) -> io::Result<()> {
        file.set_len(self.file_len)?;
        file.write_all_at(&self.head, 0)
    }
}

/// An image opened from a native file: the head in memory plus the file for bodies.
/// For tools and verification; the kernel uses [`Image`] directly.
pub struct ImageFile {
    head: Vec<u8>,
    file: File,
}

impl ImageFile {
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let file = File::open(path)?;
        let mut prefix = [0u8; HEADER_LEN];
        file.read_exact_at(&mut prefix, 0)?;
        let head_len = Image::head_len(&prefix).map_err(invalid)?;
        let mut head = vec![0u8; head_len as usize];
        file.read_exact_at(&mut head, 0)?;
        let image = Image::new(&head).map_err(invalid)?;
        image.verify_checksum().map_err(invalid)?;
        Ok(ImageFile { head, file })
    }

    pub fn image(&self) -> Image<'_> {
        Image::new(&self.head).expect("validated at open")
    }

    pub fn read_extent(&self, extent: Extent) -> io::Result<Vec<u8>> {
        let mut buf = vec![0u8; extent.len as usize];
        self.file.read_exact_at(&mut buf, extent.offset)?;
        Ok(buf)
    }

    pub fn read_body(&self, index: u32) -> io::Result<Vec<u8>> {
        let extent = self.image().entry(index).body().ok_or_else(|| invalid(ImageError::NoBody))?;
        self.read_extent(extent)
    }

    pub fn read_facts_blob(&self, index: u32) -> io::Result<Option<Vec<u8>>> {
        self.image().entry(index).facts_blob().map(|e| self.read_extent(e)).transpose()
    }

    pub fn read_compiled(&self, index: u32) -> io::Result<Option<Vec<u8>>> {
        self.image().entry(index).compiled().map(|e| self.read_extent(e)).transpose()
    }
}

fn invalid(e: ImageError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("{e:?}"))
}
