//! Streaming compression: deflate / zlib / gzip (flate2 on miniz_oxide) and
//! brotli, behind one handle type.
//!
//! `bat_z_write` consumes some input and produces some output per call and
//! reports both through `bat_z_result()` (u32 words: consumed, produced, then
//! on failure an `E_*` kind and, for brotli decoding, the decoder's error code). Its
//! return value is 1 once the stream is complete (compressor finished and
//! drained; decompressor at the end of a stream), 0 when more calls are
//! needed, -3 for an error.
//!
//! gzip framing is done here: miniz_oxide only knows raw deflate and zlib.
use crate::{bytes, bytes_mut};
use brotli::enc::encode::{BrotliEncoderDestroyInstance, BrotliEncoderOperation, BrotliEncoderParameter, BrotliEncoderStateStruct};
use brotli::enc::StandardAlloc;
use brotli::{BrotliDecompressStream, BrotliResult, BrotliState};
use flate2::{Compress, Compression, Decompress, FlushCompress, FlushDecompress, Status};

static mut RESULT: [u32; 4] = [0; 4];

const DATA_ERROR: i32 = -3;
const E_HEADER: u32 = 1;
const E_DATA: u32 = 2;
const E_CRC: u32 = 3;
const E_LENGTH: u32 = 4;
const E_BROTLI: u32 = 5;

// Modes, as passed to `bat_z_new`.
const DEFLATE: u32 = 0;
const INFLATE: u32 = 1;
const GZIP: u32 = 2;
const GUNZIP: u32 = 3;
const DEFLATE_RAW: u32 = 4;
const INFLATE_RAW: u32 = 5;
const UNZIP: u32 = 6;
const BROTLI_ENCODE: u32 = 7;
const BROTLI_DECODE: u32 = 8;

struct Io<'a> {
    input: &'a [u8],
    out: &'a mut [u8],
    consumed: usize,
    produced: usize,
    error: u32,
    detail: i32,
}

impl Io<'_> {
    fn rest(&self) -> &[u8] {
        &self.input[self.consumed..]
    }
    /// Copy as much of `pending[*pos..]` as fits; true when all of it is out.
    fn drain(&mut self, pending: &[u8], pos: &mut usize) -> bool {
        let n = (pending.len() - *pos).min(self.out.len() - self.produced);
        self.out[self.produced..self.produced + n].copy_from_slice(&pending[*pos..*pos + n]);
        self.produced += n;
        *pos += n;
        *pos == pending.len()
    }
    fn fail(&mut self, error: u32) -> i32 {
        self.error = error;
        DATA_ERROR
    }
}

pub struct Deflater {
    c: Compress,
    gzip: bool,
    level: u32,
    /// gzip header or trailer waiting for output space.
    pending: Vec<u8>,
    pending_pos: usize,
    started: bool,
    finished: bool,
    crc: crc32fast::Hasher,
    size: u32,
}

impl Deflater {
    fn new(mode: u32, level: u32) -> Deflater {
        Deflater {
            c: Compress::new(Compression::new(level), mode == DEFLATE),
            gzip: mode == GZIP,
            level,
            pending: Vec::new(),
            pending_pos: 0,
            started: false,
            finished: false,
            crc: crc32fast::Hasher::new(),
            size: 0,
        }
    }

    fn reset(&mut self) {
        self.c.reset();
        self.pending.clear();
        self.pending_pos = 0;
        self.started = false;
        self.finished = false;
        self.crc = crc32fast::Hasher::new();
        self.size = 0;
    }

    fn write(&mut self, io: &mut Io, flush: u32) -> i32 {
        if !self.started {
            self.started = true;
            if self.gzip {
                // No name, no mtime; XFL as zlib sets it; OS 3 (Unix), like Node on Linux.
                let xfl = match self.level { 9 => 2, 1 => 4, _ => 0 };
                self.pending.extend_from_slice(&[0x1f, 0x8b, 8, 0, 0, 0, 0, 0, xfl, 3]);
            }
        }
        if !io.drain(&self.pending, &mut self.pending_pos) {
            return 0;
        }
        if self.finished {
            return 1;
        }
        let flush = match flush {
            0 => FlushCompress::None,
            1 => FlushCompress::Partial,
            3 => FlushCompress::Full,
            4 => FlushCompress::Finish,
            _ => FlushCompress::Sync, // Z_SYNC_FLUSH, and Z_BLOCK which miniz does not have
        };
        let (in0, out0) = (self.c.total_in(), self.c.total_out());
        let status = self.c.compress(&io.input[io.consumed..], &mut io.out[io.produced..], flush);
        let taken = (self.c.total_in() - in0) as usize;
        if self.gzip {
            self.crc.update(&io.input[io.consumed..io.consumed + taken]);
            self.size = self.size.wrapping_add(taken as u32);
        }
        io.consumed += taken;
        io.produced += (self.c.total_out() - out0) as usize;
        match status {
            Ok(Status::StreamEnd) => {
                self.finished = true;
                if self.gzip {
                    self.pending.clear();
                    self.pending_pos = 0;
                    self.pending.extend_from_slice(&self.crc.clone().finalize().to_le_bytes());
                    self.pending.extend_from_slice(&self.size.to_le_bytes());
                }
                io.drain(&self.pending, &mut self.pending_pos) as i32
            }
            Ok(_) => 0,
            Err(_) => io.fail(E_DATA),
        }
    }
}

#[derive(PartialEq, Clone, Copy)]
enum Stage {
    /// unzip: waiting for the first byte to tell gzip from zlib.
    Detect,
    GzipHeader,
    Body,
    GzipTrailer,
    /// A complete stream has been read. More gzip members may follow.
    End,
}

pub struct Inflater {
    d: Decompress,
    mode: u32,
    gzip: bool,
    stage: Stage,
    /// Header or trailer bytes collected across writes.
    held: Vec<u8>,
    crc: crc32fast::Hasher,
    size: u32,
}

/// Length of the gzip header at the start of `b`: Ok(None) when incomplete.
fn gzip_header_len(b: &[u8]) -> Result<Option<usize>, ()> {
    if (!b.is_empty() && b[0] != 0x1f) || (b.len() > 1 && b[1] != 0x8b) || (b.len() > 2 && b[2] != 8) {
        return Err(());
    }
    if b.len() < 10 {
        return Ok(None);
    }
    let flags = b[3];
    if flags & 0xe0 != 0 {
        return Err(());
    }
    let mut pos = 10;
    if flags & 4 != 0 {
        if b.len() < pos + 2 {
            return Ok(None);
        }
        pos += 2 + (b[pos] as usize | (b[pos + 1] as usize) << 8);
    }
    for bit in [8, 16] {
        if flags & bit != 0 {
            match b.get(pos..).and_then(|s| s.iter().position(|&c| c == 0)) {
                Some(n) => pos += n + 1,
                None => return Ok(None),
            }
        }
    }
    if flags & 2 != 0 {
        pos += 2;
    }
    Ok(if b.len() < pos { None } else { Some(pos) })
}

impl Inflater {
    fn new(mode: u32) -> Inflater {
        let mut s = Inflater {
            d: Decompress::new(mode == INFLATE),
            mode,
            gzip: false,
            stage: Stage::Body,
            held: Vec::new(),
            crc: crc32fast::Hasher::new(),
            size: 0,
        };
        s.reset();
        s
    }

    fn reset(&mut self) {
        self.gzip = self.mode == GUNZIP;
        self.stage = match self.mode {
            GUNZIP => Stage::GzipHeader,
            UNZIP => Stage::Detect,
            _ => Stage::Body,
        };
        self.d.reset(self.mode == INFLATE);
        self.held.clear();
        self.crc = crc32fast::Hasher::new();
        self.size = 0;
    }

    fn write(&mut self, io: &mut Io) -> i32 {
        loop {
            match self.stage {
                Stage::Detect => {
                    let Some(&first) = io.rest().first() else { return 0 };
                    self.gzip = first == 0x1f;
                    self.d.reset(!self.gzip);
                    self.stage = if self.gzip { Stage::GzipHeader } else { Stage::Body };
                }
                Stage::GzipHeader => {
                    if io.rest().is_empty() {
                        return 0;
                    }
                    let before = self.held.len();
                    let take = io.rest().len().min(1024);
                    self.held.extend_from_slice(&io.rest()[..take]);
                    match gzip_header_len(&self.held) {
                        Ok(Some(n)) => {
                            io.consumed += n - before;
                            self.held.clear();
                            self.crc = crc32fast::Hasher::new();
                            self.size = 0;
                            self.stage = Stage::Body;
                        }
                        Ok(None) => io.consumed += take,
                        Err(()) => return io.fail(E_HEADER),
                    }
                }
                Stage::Body => {
                    let (in0, out0) = (self.d.total_in(), self.d.total_out());
                    let status = self.d.decompress(&io.input[io.consumed..], &mut io.out[io.produced..], FlushDecompress::None);
                    let made = (self.d.total_out() - out0) as usize;
                    if self.gzip {
                        self.crc.update(&io.out[io.produced..io.produced + made]);
                        self.size = self.size.wrapping_add(made as u32);
                    }
                    io.consumed += (self.d.total_in() - in0) as usize;
                    io.produced += made;
                    match status {
                        Ok(Status::StreamEnd) => self.stage = if self.gzip { Stage::GzipTrailer } else { Stage::End },
                        Ok(_) => return 0,
                        Err(_) => {
                            let at_start = in0 == 0 && self.d.total_out() == 0 && self.mode != INFLATE_RAW && !self.gzip;
                            return io.fail(if at_start { E_HEADER } else { E_DATA });
                        }
                    }
                }
                Stage::GzipTrailer => {
                    let take = (8 - self.held.len()).min(io.rest().len());
                    self.held.extend_from_slice(&io.rest()[..take]);
                    io.consumed += take;
                    if self.held.len() < 8 {
                        return 0;
                    }
                    let word = |i: usize| u32::from_le_bytes([self.held[i], self.held[i + 1], self.held[i + 2], self.held[i + 3]]);
                    if word(0) != self.crc.clone().finalize() {
                        return io.fail(E_CRC);
                    }
                    if word(4) != self.size {
                        return io.fail(E_LENGTH);
                    }
                    self.held.clear();
                    self.stage = Stage::End;
                }
                Stage::End => {
                    if self.gzip && io.rest().first().is_some_and(|&b| b != 0) {
                        // Concatenated gzip members decompress as one stream. As in Node, anything
                        // after a member that is not zero padding has to be another member.
                        self.d.reset(false);
                        self.stage = Stage::GzipHeader;
                        continue;
                    }
                    io.consumed = io.input.len();
                    return 1;
                }
            }
        }
    }
}

pub struct BrotliEnc {
    s: BrotliEncoderStateStruct<StandardAlloc>,
    params: [u32; 4],
}

fn brotli_encoder(params: [u32; 4]) -> BrotliEncoderStateStruct<StandardAlloc> {
    let mut s = BrotliEncoderStateStruct::new(StandardAlloc::default());
    s.set_parameter(BrotliEncoderParameter::BROTLI_PARAM_QUALITY, params[0]);
    s.set_parameter(BrotliEncoderParameter::BROTLI_PARAM_LGWIN, params[1]);
    s.set_parameter(BrotliEncoderParameter::BROTLI_PARAM_MODE, params[2]);
    if params[3] != 0 {
        s.set_parameter(BrotliEncoderParameter::BROTLI_PARAM_SIZE_HINT, params[3]);
    }
    s
}

impl BrotliEnc {
    fn write(&mut self, io: &mut Io, op: u32) -> i32 {
        let op = match op {
            0 => BrotliEncoderOperation::BROTLI_OPERATION_PROCESS,
            1 => BrotliEncoderOperation::BROTLI_OPERATION_FLUSH,
            _ => BrotliEncoderOperation::BROTLI_OPERATION_FINISH,
        };
        let mut avail_in = io.input.len() - io.consumed;
        let mut in_pos = io.consumed;
        let mut avail_out = io.out.len() - io.produced;
        let mut out_pos = io.produced;
        let mut total = None;
        let ok = self.s.compress_stream(op, &mut avail_in, io.input, &mut in_pos, &mut avail_out, io.out, &mut out_pos, &mut total, &mut |_, _, _, _| ());
        io.consumed = in_pos;
        io.produced = out_pos;
        if !ok {
            return io.fail(E_BROTLI);
        }
        self.s.is_finished() as i32
    }
}

pub struct BrotliDec {
    s: BrotliState<StandardAlloc, StandardAlloc, StandardAlloc>,
    done: bool,
}

fn brotli_decoder() -> BrotliState<StandardAlloc, StandardAlloc, StandardAlloc> {
    BrotliState::new(StandardAlloc::default(), StandardAlloc::default(), StandardAlloc::default())
}

impl BrotliDec {
    fn write(&mut self, io: &mut Io) -> i32 {
        if self.done {
            io.consumed = io.input.len();
            return 1;
        }
        let mut avail_in = io.input.len() - io.consumed;
        let mut in_pos = io.consumed;
        let mut avail_out = io.out.len() - io.produced;
        let mut out_pos = io.produced;
        let mut total = 0;
        let r = BrotliDecompressStream(&mut avail_in, &mut in_pos, io.input, &mut avail_out, &mut out_pos, io.out, &mut total, &mut self.s);
        io.consumed = in_pos;
        io.produced = out_pos;
        match r {
            BrotliResult::ResultSuccess => {
                self.done = true;
                io.consumed = io.input.len();
                1
            }
            BrotliResult::ResultFailure => {
                io.detail = self.s.error_code as i32;
                io.fail(E_BROTLI)
            }
            _ => 0,
        }
    }
}

pub enum Stream {
    Deflate(Deflater),
    Inflate(Inflater),
    BrotliEnc(Box<BrotliEnc>),
    BrotliDec(Box<BrotliDec>),
}

/// Modes: 0 deflate (zlib), 1 inflate, 2 gzip, 3 gunzip, 4 raw deflate,
/// 5 raw inflate, 6 unzip (gzip or zlib by the first byte), 7 brotli encode,
/// 8 brotli decode. `a` is the level 0-9 for the deflate family; for brotli
/// encode `a`..`d` are quality, lgwin, mode, size hint.
#[no_mangle]
pub extern "C" fn bat_z_new(mode: u32, a: u32, b: u32, c: u32, d: u32) -> *mut Stream {
    let s = match mode {
        DEFLATE | GZIP | DEFLATE_RAW => Stream::Deflate(Deflater::new(mode, a.min(9))),
        INFLATE | GUNZIP | INFLATE_RAW | UNZIP => Stream::Inflate(Inflater::new(mode)),
        BROTLI_ENCODE => {
            let params = [a.min(11), b.clamp(10, 24), c.min(2), d];
            Stream::BrotliEnc(Box::new(BrotliEnc { s: brotli_encoder(params), params }))
        }
        BROTLI_DECODE => Stream::BrotliDec(Box::new(BrotliDec { s: brotli_decoder(), done: false })),
        _ => return core::ptr::null_mut(),
    };
    Box::into_raw(Box::new(s))
}

/// `flush` is zlib's Z_NO_FLUSH..Z_FINISH for the deflate family and the
/// BROTLI_OPERATION_* value for brotli encode; decoders ignore it.
#[no_mangle]
pub unsafe extern "C" fn bat_z_write(h: *mut Stream, input: *const u8, in_len: usize, out: *mut u8, out_cap: usize, flush: u32) -> i32 {
    let mut io = Io { input: bytes(input, in_len), out: bytes_mut(out, out_cap), consumed: 0, produced: 0, error: 0, detail: 0 };
    let status = match &mut *h {
        Stream::Deflate(s) => s.write(&mut io, flush),
        Stream::Inflate(s) => s.write(&mut io),
        Stream::BrotliEnc(s) => s.write(&mut io, flush),
        Stream::BrotliDec(s) => s.write(&mut io),
    };
    let result = &mut *core::ptr::addr_of_mut!(RESULT);
    *result = [io.consumed as u32, io.produced as u32, io.error, io.detail as u32];
    status
}

#[no_mangle]
pub extern "C" fn bat_z_result() -> *const u32 {
    core::ptr::addr_of!(RESULT) as *const u32
}

#[no_mangle]
pub unsafe extern "C" fn bat_z_reset(h: *mut Stream) {
    match &mut *h {
        Stream::Deflate(s) => s.reset(),
        Stream::Inflate(s) => s.reset(),
        Stream::BrotliEnc(s) => {
            BrotliEncoderDestroyInstance(&mut s.s);
            s.s = brotli_encoder(s.params);
        }
        Stream::BrotliDec(s) => {
            s.s = brotli_decoder();
            s.done = false;
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn bat_z_free(h: *mut Stream) {
    let mut s = Box::from_raw(h);
    if let Stream::BrotliEnc(e) = &mut *s {
        BrotliEncoderDestroyInstance(&mut e.s);
    }
}
