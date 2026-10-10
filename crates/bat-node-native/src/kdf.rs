//! Key derivation: PBKDF2-HMAC, HKDF, scrypt. All return 0 on success, -1 when
//! the parameters are rejected.
use crate::digest::{hmac_once, with_alg, MAX_OUT};
use crate::{bytes, bytes_mut};

#[no_mangle]
pub unsafe extern "C" fn bat_pbkdf2(
    alg: u32, pw: *const u8, pw_len: usize, salt: *const u8, salt_len: usize,
    iterations: u32, out: *mut u8, out_len: usize,
) -> i32 {
    let (pw, salt, out) = (bytes(pw, pw_len), bytes(salt, salt_len), bytes_mut(out, out_len));
    if iterations == 0 {
        return -1;
    }
    with_alg!(alg, D => { pbkdf2::pbkdf2_hmac::<D>(pw, salt, iterations, out); 0 }, -1)
}

#[no_mangle]
pub unsafe extern "C" fn bat_hkdf(
    alg: u32, ikm: *const u8, ikm_len: usize, salt: *const u8, salt_len: usize,
    info: *const u8, info_len: usize, out: *mut u8, out_len: usize,
) -> i32 {
    let (ikm, salt, info, out) = (bytes(ikm, ikm_len), bytes(salt, salt_len), bytes(info, info_len), bytes_mut(out, out_len));
    let mut prk = [0u8; MAX_OUT];
    // RFC 5869: an absent salt is HashLen zero bytes, which HMAC's key padding makes equal to an empty key.
    let Some(n) = hmac_once(alg, salt, &[ikm], &mut prk) else { return -1 };
    if out.len() > 255 * n {
        return -1;
    }
    let mut t = [0u8; MAX_OUT];
    let mut t_len = 0;
    for (i, chunk) in out.chunks_mut(n).enumerate() {
        let prev = t;
        hmac_once(alg, &prk[..n], &[&prev[..t_len], info, &[i as u8 + 1]], &mut t);
        t_len = n;
        chunk.copy_from_slice(&t[..chunk.len()]);
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn bat_scrypt(
    pw: *const u8, pw_len: usize, salt: *const u8, salt_len: usize,
    log_n: u32, r: u32, p: u32, out: *mut u8, out_len: usize,
) -> i32 {
    let Ok(params) = scrypt::Params::new(log_n as u8, r, p, 32) else { return -1 };
    match scrypt::scrypt(bytes(pw, pw_len), bytes(salt, salt_len), &params, bytes_mut(out, out_len)) {
        Ok(()) => 0,
        Err(_) => -1,
    }
}
