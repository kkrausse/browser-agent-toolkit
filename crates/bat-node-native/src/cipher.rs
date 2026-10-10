//! AES in CBC (PKCS#7), CTR and GCM, as streaming ciphers the way
//! `crypto.createCipheriv` needs them: `update` returns output as input
//! arrives, `final` pads / unpads or produces / checks the GCM tag.
//!
//! The block cipher is the `aes` crate and GHASH the `ghash` crate; the modes
//! are composed here because the one-shot AEAD crates cannot stream.
use crate::{bytes, bytes_mut};
use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit};
use aes::{Aes128, Aes192, Aes256, Block};
use ghash::universal_hash::UniversalHash;
use ghash::GHash;

enum Key {
    A128(Aes128),
    A192(Aes192),
    A256(Aes256),
}

impl Key {
    fn new(k: &[u8]) -> Option<Key> {
        match k.len() {
            16 => Aes128::new_from_slice(k).ok().map(Key::A128),
            24 => Aes192::new_from_slice(k).ok().map(Key::A192),
            32 => Aes256::new_from_slice(k).ok().map(Key::A256),
            _ => None,
        }
    }
    fn enc(&self, b: &mut [Block]) {
        match self {
            Key::A128(c) => c.encrypt_blocks(b),
            Key::A192(c) => c.encrypt_blocks(b),
            Key::A256(c) => c.encrypt_blocks(b),
        }
    }
    fn dec(&self, b: &mut [Block]) {
        match self {
            Key::A128(c) => c.decrypt_blocks(b),
            Key::A192(c) => c.decrypt_blocks(b),
            Key::A256(c) => c.decrypt_blocks(b),
        }
    }
}

/// View a byte slice whose length is a multiple of 16 as AES blocks.
fn as_blocks(b: &mut [u8]) -> &mut [Block] {
    debug_assert!(b.len() % 16 == 0);
    // SAFETY: `Block` is `GenericArray<u8, U16>`, sixteen bytes with alignment 1.
    unsafe { core::slice::from_raw_parts_mut(b.as_mut_ptr() as *mut Block, b.len() / 16) }
}

const CBC: u32 = 0;
const CTR: u32 = 1;
const GCM: u32 = 2;

struct Gcm {
    ghash: GHash,
    j0: [u8; 16],
    aad: Vec<u8>,
    started: bool,
    ct_len: u64,
    part: [u8; 16],
    fill: usize,
}

impl Gcm {
    fn start(&mut self) {
        if !self.started {
            self.started = true;
            self.ghash.update_padded(&self.aad);
        }
    }
    fn absorb(&mut self, mut data: &[u8]) {
        self.ct_len += data.len() as u64;
        if self.fill > 0 {
            let n = (16 - self.fill).min(data.len());
            self.part[self.fill..self.fill + n].copy_from_slice(&data[..n]);
            self.fill += n;
            data = &data[n..];
            if self.fill < 16 {
                return;
            }
            self.ghash.update(&[Block::from(self.part)]);
            self.fill = 0;
        }
        let whole = data.len() / 16 * 16;
        self.ghash.update_padded(&data[..whole]);
        let rest = &data[whole..];
        self.part[..rest.len()].copy_from_slice(rest);
        self.fill = rest.len();
    }
    fn tag(&mut self, key: &Key) -> [u8; 16] {
        self.start();
        if self.fill > 0 {
            self.ghash.update_padded(&self.part[..self.fill]);
        }
        let mut lens = [0u8; 16];
        lens[..8].copy_from_slice(&(self.aad.len() as u64 * 8).to_be_bytes());
        lens[8..].copy_from_slice(&(self.ct_len * 8).to_be_bytes());
        self.ghash.update(&[Block::from(lens)]);
        let s = self.ghash.clone().finalize();
        let mut e = Block::from(self.j0);
        key.enc(core::slice::from_mut(&mut e));
        let mut tag = [0u8; 16];
        for i in 0..16 {
            tag[i] = s[i] ^ e[i];
        }
        tag
    }
}

pub struct Cipher {
    key: Key,
    mode: u32,
    encrypt: bool,
    padding: bool,
    /// CBC chaining value, or the next counter block.
    iv: [u8; 16],
    /// CBC: input not yet forming a processable block.
    pend: Vec<u8>,
    /// CTR/GCM: unused keystream of the current block.
    ks: [u8; 16],
    ks_pos: usize,
    gcm: Option<Gcm>,
}

impl Cipher {
    fn new(mode: u32, encrypt: bool, key: &[u8], iv: &[u8]) -> Option<Cipher> {
        let key = Key::new(key)?;
        let mut c = Cipher { key, mode, encrypt, padding: true, iv: [0; 16], pend: Vec::new(), ks: [0; 16], ks_pos: 16, gcm: None };
        match mode {
            CBC | CTR => {
                if iv.len() != 16 {
                    return None;
                }
                c.iv.copy_from_slice(iv);
            }
            GCM => {
                if iv.is_empty() {
                    return None;
                }
                let mut h = Block::default();
                c.key.enc(core::slice::from_mut(&mut h));
                let mut j0 = [0u8; 16];
                if iv.len() == 12 {
                    j0[..12].copy_from_slice(iv);
                    j0[15] = 1;
                } else {
                    let mut g = GHash::new(&h);
                    g.update_padded(iv);
                    let mut lens = [0u8; 16];
                    lens[8..].copy_from_slice(&(iv.len() as u64 * 8).to_be_bytes());
                    g.update(&[Block::from(lens)]);
                    j0.copy_from_slice(&g.finalize());
                }
                c.iv = j0;
                c.bump();
                c.gcm = Some(Gcm { ghash: GHash::new(&h), j0, aad: Vec::new(), started: false, ct_len: 0, part: [0; 16], fill: 0 });
            }
            _ => return None,
        }
        Some(c)
    }

    /// Advance the counter block: 32-bit for GCM, the whole block for CTR.
    fn bump(&mut self) {
        if self.mode == GCM {
            let n = u32::from_be_bytes([self.iv[12], self.iv[13], self.iv[14], self.iv[15]]).wrapping_add(1);
            self.iv[12..].copy_from_slice(&n.to_be_bytes());
        } else {
            self.iv = u128::from_be_bytes(self.iv).wrapping_add(1).to_be_bytes();
        }
    }

    /// XOR the keystream into `data` in place.
    fn keystream(&mut self, mut data: &mut [u8]) {
        while self.ks_pos < 16 && !data.is_empty() {
            data[0] ^= self.ks[self.ks_pos];
            self.ks_pos += 1;
            data = &mut data[1..];
        }
        let mut batch = [Block::default(); 8];
        while data.len() >= 16 {
            let n = (data.len() / 16).min(8);
            for b in batch[..n].iter_mut() {
                *b = Block::from(self.iv);
                self.bump();
            }
            self.key.enc(&mut batch[..n]);
            let (head, tail) = data.split_at_mut(n * 16);
            for (d, k) in head.iter_mut().zip(batch[..n].iter().flat_map(|b| b.iter())) {
                *d ^= k;
            }
            data = tail;
        }
        if !data.is_empty() {
            let mut b = Block::from(self.iv);
            self.bump();
            self.key.enc(core::slice::from_mut(&mut b));
            self.ks.copy_from_slice(&b);
            for (i, d) in data.iter_mut().enumerate() {
                *d ^= self.ks[i];
            }
            self.ks_pos = data.len();
        }
    }

    /// CBC over `data`, whole blocks, in place.
    fn cbc(&mut self, data: &mut [u8]) {
        if self.encrypt {
            for block in data.chunks_exact_mut(16) {
                for i in 0..16 {
                    block[i] ^= self.iv[i];
                }
                self.key.enc(as_blocks(block));
                self.iv.copy_from_slice(block);
            }
        } else if !data.is_empty() {
            let cipher = data.to_vec();
            self.key.dec(as_blocks(data));
            for i in 0..data.len() {
                data[i] ^= if i < 16 { self.iv[i] } else { cipher[i - 16] };
            }
            self.iv.copy_from_slice(&cipher[cipher.len() - 16..]);
        }
    }

    /// `out` holds at least `input.len() + 16` bytes. Returns the bytes written.
    fn update(&mut self, input: &[u8], out: &mut [u8]) -> usize {
        if self.mode == CBC {
            self.pend.extend_from_slice(input);
            let len = self.pend.len();
            // Decrypting with padding keeps the last block back: it may be the padding block.
            let n = if !self.encrypt && self.padding { len.saturating_sub(1) / 16 * 16 } else { len / 16 * 16 };
            out[..n].copy_from_slice(&self.pend[..n]);
            self.pend.drain(..n);
            self.cbc(&mut out[..n]);
            return n;
        }
        let out = &mut out[..input.len()];
        out.copy_from_slice(input);
        if let Some(g) = &mut self.gcm {
            g.start();
            if !self.encrypt {
                g.absorb(input);
            }
        }
        self.keystream(out);
        if self.encrypt {
            if let Some(g) = &mut self.gcm {
                g.absorb(out);
            }
        }
        input.len()
    }

    /// Returns bytes written, -1 for bad padding / failed authentication, -2 for a wrong final block length.
    fn finish(&mut self, out: &mut [u8], tag: &mut [u8]) -> i32 {
        match self.mode {
            CBC => {
                let len = self.pend.len();
                if self.encrypt {
                    if !self.padding {
                        return if len == 0 { 0 } else { -2 };
                    }
                    let pad = 16 - len;
                    out[..len].copy_from_slice(&self.pend);
                    out[len..16].fill(pad as u8);
                    self.cbc(&mut out[..16]);
                    16
                } else {
                    if !self.padding {
                        return if len == 0 { 0 } else { -2 };
                    }
                    if len != 16 {
                        return -2;
                    }
                    let mut last = [0u8; 16];
                    last.copy_from_slice(&self.pend);
                    self.cbc(&mut last);
                    let pad = last[15] as usize;
                    if pad == 0 || pad > 16 || last[16 - pad..].iter().any(|&b| b as usize != pad) {
                        return -1;
                    }
                    out[..16 - pad].copy_from_slice(&last[..16 - pad]);
                    (16 - pad) as i32
                }
            }
            GCM => {
                let Some(g) = &mut self.gcm else { return -1 };
                let computed = g.tag(&self.key);
                if self.encrypt {
                    tag[..16].copy_from_slice(&computed);
                    return 0;
                }
                if tag.len() < 4 || tag.len() > 16 {
                    return -1;
                }
                let diff = tag.iter().zip(computed.iter()).fold(0u8, |acc, (a, b)| acc | (a ^ b));
                if core::hint::black_box(diff) == 0 { 0 } else { -1 }
            }
            _ => 0,
        }
    }
}

/// mode: 0 CBC, 1 CTR, 2 GCM. The key length selects AES-128/192/256.
#[no_mangle]
pub unsafe extern "C" fn bat_cipher_new(mode: u32, encrypt: u32, key: *const u8, key_len: usize, iv: *const u8, iv_len: usize) -> *mut Cipher {
    match Cipher::new(mode, encrypt != 0, bytes(key, key_len), bytes(iv, iv_len)) {
        Some(c) => Box::into_raw(Box::new(c)),
        None => core::ptr::null_mut(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn bat_cipher_aad(h: *mut Cipher, data: *const u8, len: usize) {
    if let Some(g) = &mut (*h).gcm {
        g.aad.extend_from_slice(bytes(data, len));
    }
}

#[no_mangle]
pub unsafe extern "C" fn bat_cipher_padding(h: *mut Cipher, on: u32) {
    (*h).padding = on != 0;
}

/// `out` must have room for `len + 16` bytes and must not overlap the input.
#[no_mangle]
pub unsafe extern "C" fn bat_cipher_update(h: *mut Cipher, data: *const u8, len: usize, out: *mut u8) -> usize {
    (*h).update(bytes(data, len), bytes_mut(out, len + 16))
}

/// `out` has room for 16 bytes. Encrypting GCM writes a 16-byte tag to `tag`;
/// decrypting GCM compares against the `tag_len` bytes there.
#[no_mangle]
pub unsafe extern "C" fn bat_cipher_final(h: *mut Cipher, out: *mut u8, tag: *mut u8, tag_len: usize) -> i32 {
    (*h).finish(bytes_mut(out, 16), bytes_mut(tag, tag_len))
}

#[no_mangle]
pub unsafe extern "C" fn bat_cipher_free(h: *mut Cipher) {
    drop(Box::from_raw(h));
}
