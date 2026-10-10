//! rustls behind a C ABI, for a caller that owns the transport.
//!
//! The caller (runtime/src/net/tunnel.ts) moves ciphertext between this and a byte stream it
//! has (a WebSocket to a TCP relay) and plaintext between this and its HTTP client. Nothing
//! here does I/O. The trust anchors are the Mozilla roots of the `webpki-roots` crate,
//! compiled in; the server's chain and name are checked by rustls's webpki verifier, and no
//! function of this ABI can add an anchor or turn the check off.
use std::io::{Read, Write};
use std::sync::{Arc, OnceLock};

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, RootCertStore};

pub struct Conn {
    tls: ClientConnection,
    error: String,
}

static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
static mut LAST_ERROR: String = String::new();

#[cfg(feature = "test-root")]
const TEST_ROOT: &[u8] = include_bytes!(env!("BAT_TLS_TEST_ROOT"));

fn config() -> Arc<ClientConfig> {
    CONFIG
        .get_or_init(|| {
            let mut roots = RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            #[cfg(feature = "test-root")]
            roots
                .add(rustls::pki_types::CertificateDer::from(TEST_ROOT.to_vec()))
                .expect("BAT_TLS_TEST_ROOT is not a usable certificate");
            let provider = Arc::new(rustls::crypto::ring::default_provider());
            let mut config = ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .expect("protocol versions")
                .with_root_certificates(roots)
                .with_no_client_auth();
            // The caller speaks HTTP/1.1 only.
            config.alpn_protocols = vec![b"http/1.1".to_vec()];
            Arc::new(config)
        })
        .clone()
}

unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 { &[] } else { std::slice::from_raw_parts(ptr, len) }
}
unsafe fn bytes_mut<'a>(ptr: *mut u8, len: usize) -> &'a mut [u8] {
    if len == 0 { &mut [] } else { std::slice::from_raw_parts_mut(ptr, len) }
}
fn copy_text(text: &str, ptr: *mut u8, cap: usize) -> usize {
    let n = text.len().min(cap);
    unsafe { bytes_mut(ptr, n) }.copy_from_slice(&text.as_bytes()[..n]);
    n
}

#[no_mangle]
pub extern "C" fn bat_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

/// # Safety
/// `ptr` and `len` as given to and by `bat_alloc`.
#[no_mangle]
pub unsafe extern "C" fn bat_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

/// 1 when this build trusts a test certificate besides the public roots.
#[no_mangle]
pub extern "C" fn tls_test_build() -> i32 {
    cfg!(feature = "test-root") as i32
}

/// A client connection to `host` (a DNS name: it is sent as SNI and the certificate must be
/// valid for it). Null when the name is unusable; `tls_error(null, ..)` says why.
///
/// # Safety
/// `host` points at `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn tls_new(host: *const u8, len: usize) -> *mut Conn {
    let made = std::str::from_utf8(bytes(host, len))
        .map_err(|e| e.to_string())
        .and_then(|name| ServerName::try_from(name.to_owned()).map_err(|e| e.to_string()))
        .and_then(|name| ClientConnection::new(config(), name).map_err(|e| e.to_string()));
    match made {
        Ok(tls) => Box::into_raw(Box::new(Conn { tls, error: String::new() })),
        Err(error) => {
            #[allow(static_mut_refs)]
            {
                LAST_ERROR = error;
            }
            std::ptr::null_mut()
        }
    }
}

/// # Safety
/// `conn` from `tls_new`, not used afterwards.
#[no_mangle]
pub unsafe extern "C" fn tls_free(conn: *mut Conn) {
    if !conn.is_null() {
        drop(Box::from_raw(conn));
    }
}

/// Bytes received from the network. Returns how many were taken (all of them unless the
/// connection's plaintext buffer is full: read with `tls_read` and give the rest again),
/// or -1 after an error (`tls_error`); what `tls_out` then holds is the alert to send.
///
/// # Safety
/// `conn` from `tls_new`; `ptr` points at `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn tls_in(conn: *mut Conn, ptr: *const u8, len: usize) -> i32 {
    let conn = &mut *conn;
    let mut rest = bytes(ptr, len);
    let total = rest.len();
    while !rest.is_empty() {
        let before = rest.len();
        match conn.tls.read_tls(&mut rest) {
            Ok(_) => {}
            // The plaintext buffer is full.
            Err(_) => break,
        }
        if let Err(error) = conn.tls.process_new_packets() {
            conn.error = error.to_string();
            return -1;
        }
        if rest.len() == before {
            break;
        }
    }
    (total - rest.len()) as i32
}

/// The network's end of stream.
///
/// # Safety
/// `conn` from `tls_new`.
#[no_mangle]
pub unsafe extern "C" fn tls_in_eof(conn: *mut Conn) {
    let conn = &mut *conn;
    let _ = conn.tls.read_tls(&mut std::io::empty());
    let _ = conn.tls.process_new_packets();
}

/// Bytes for the network, up to `cap`; 0 when there are none.
///
/// # Safety
/// `conn` from `tls_new`; `ptr` points at `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn tls_out(conn: *mut Conn, ptr: *mut u8, cap: usize) -> i32 {
    let conn = &mut *conn;
    let mut out = bytes_mut(ptr, cap);
    while conn.tls.wants_write() && !out.is_empty() {
        match conn.tls.write_tls(&mut out) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
    (cap - out.len()) as i32
}

/// Plaintext to send. Returns how many bytes were taken (fewer than `len` when the
/// connection's buffer is full: empty it with `tls_out` and give the rest again).
///
/// # Safety
/// `conn` from `tls_new`; `ptr` points at `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn tls_write(conn: *mut Conn, ptr: *const u8, len: usize) -> i32 {
    let conn = &mut *conn;
    match conn.tls.writer().write(bytes(ptr, len)) {
        Ok(n) => n as i32,
        Err(error) => {
            conn.error = error.to_string();
            -1
        }
    }
}

/// Received plaintext, up to `cap`. 0: none now. -1: the peer ended the stream properly
/// (close_notify). -2: the stream ended without that, or another error (`tls_error`).
///
/// # Safety
/// `conn` from `tls_new`; `ptr` points at `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn tls_read(conn: *mut Conn, ptr: *mut u8, cap: usize) -> i32 {
    let conn = &mut *conn;
    match conn.tls.reader().read(bytes_mut(ptr, cap)) {
        Ok(0) => -1,
        Ok(n) => n as i32,
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => 0,
        Err(error) => {
            conn.error = error.to_string();
            -2
        }
    }
}

/// Queue the close_notify alert (`tls_out` then holds it).
///
/// # Safety
/// `conn` from `tls_new`.
#[no_mangle]
pub unsafe extern "C" fn tls_close(conn: *mut Conn) {
    (*conn).tls.send_close_notify();
}

/// # Safety
/// `conn` from `tls_new`.
#[no_mangle]
pub unsafe extern "C" fn tls_handshaking(conn: *mut Conn) -> i32 {
    (*conn).tls.is_handshaking() as i32
}

/// The last error of `conn` (of `tls_new` when null), as text; returns its length.
///
/// # Safety
/// `conn` from `tls_new` or null; `ptr` points at `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn tls_error(conn: *mut Conn, ptr: *mut u8, cap: usize) -> i32 {
    #[allow(static_mut_refs)]
    let text: &str = if conn.is_null() { &LAST_ERROR } else { &(*conn).error };
    copy_text(text, ptr, cap) as i32
}

/// What was negotiated, e.g. `TLSv1_3 TLS13_AES_256_GCM_SHA384`; empty during the handshake.
///
/// # Safety
/// `conn` from `tls_new`; `ptr` points at `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn tls_info(conn: *mut Conn, ptr: *mut u8, cap: usize) -> i32 {
    let conn = &*conn;
    let text = match (conn.tls.protocol_version(), conn.tls.negotiated_cipher_suite()) {
        (Some(version), Some(suite)) => format!("{:?} {:?}", version, suite.suite()),
        _ => String::new(),
    };
    copy_text(&text, ptr, cap) as i32
}
