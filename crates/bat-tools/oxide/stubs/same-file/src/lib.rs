//! The part of `same-file` 1.0.6's API that `walkdir` and `ignore` use, for
//! targets where the published crate only returns "not supported".
//!
//! Two handles are equal when their paths canonicalize to the same path. The
//! callers only ask "is this symlinked directory one of its own ancestors",
//! and a directory has exactly one canonical path, so this answers the same
//! question as the device and inode comparison on Unix, without trusting a
//! host file system (the browser guest's) to hand out real inode numbers.

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct Handle {
    canonical: PathBuf,
    file: Option<File>,
}

impl PartialEq for Handle {
    fn eq(&self, other: &Handle) -> bool {
        self.canonical == other.canonical
    }
}

impl Eq for Handle {}

impl std::hash::Hash for Handle {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.canonical.hash(state);
    }
}

fn unsupported<T>(what: &str) -> io::Result<T> {
    Err(io::Error::new(io::ErrorKind::Unsupported, format!("same-file: {what} is not supported on this platform")))
}

impl Handle {
    pub fn from_path<P: AsRef<Path>>(path: P) -> io::Result<Handle> {
        Ok(Handle { canonical: std::fs::canonicalize(path)?, file: None })
    }

    pub fn from_file(_file: File) -> io::Result<Handle> {
        unsupported("a handle from an open file")
    }

    pub fn stdin() -> io::Result<Handle> {
        unsupported("stdin")
    }

    pub fn stdout() -> io::Result<Handle> {
        unsupported("stdout")
    }

    pub fn stderr() -> io::Result<Handle> {
        unsupported("stderr")
    }

    pub fn as_file(&self) -> &File {
        self.file.as_ref().expect("same-file: no open file behind this handle")
    }

    pub fn as_file_mut(&mut self) -> &mut File {
        self.file.as_mut().expect("same-file: no open file behind this handle")
    }
}

pub fn is_same_file<P, Q>(path1: P, path2: Q) -> io::Result<bool>
where
    P: AsRef<Path>,
    Q: AsRef<Path>,
{
    Ok(Handle::from_path(path1)? == Handle::from_path(path2)?)
}
