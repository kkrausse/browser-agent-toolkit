//! Line-discipline behaviours, each stated the way a Linux tty behaves.

use crate::pty::{Pty, ReadResult};
use crate::termios::*;

fn pty() -> Pty {
    Pty::new(80, 24)
}

/// Everything echoed / written towards the terminal so far.
fn out(p: &mut Pty) -> String {
    let mut buf = [0u8; 8192];
    let n = p.master_read(&mut buf);
    String::from_utf8_lossy(&buf[..n]).into_owned()
}

fn typed(p: &mut Pty, s: &str) {
    p.master_write(s.as_bytes(), 0.0);
}

fn read(p: &mut Pty, cap: usize) -> ReadResult {
    let mut buf = vec![0u8; cap];
    p.read_begin(0.0);
    p.read(&mut buf, 0.0)
}

fn read_str(p: &mut Pty) -> Option<String> {
    let mut buf = [0u8; 4096];
    p.read_begin(0.0);
    match p.read(&mut buf, 0.0) {
        ReadResult::Data(n) => Some(String::from_utf8_lossy(&buf[..n]).into_owned()),
        ReadResult::Block(_) => None,
    }
}

fn set(p: &mut Pty, f: impl FnOnce(&mut Termios)) {
    let mut t = p.termios();
    f(&mut t);
    p.set_termios(TCSANOW, t);
}

fn raw(p: &mut Pty) {
    set(p, |t| t.make_raw());
}

// ---- canonical mode --------------------------------------------------------

#[test]
fn canonical_read_blocks_until_newline() {
    let mut p = pty();
    typed(&mut p, "hel");
    assert_eq!(read(&mut p, 100), ReadResult::Block(None));
    assert!(!p.poll_in());
    typed(&mut p, "lo\r");
    assert!(p.poll_in());
    // ICRNL: the CR typed by the Enter key arrives as NL.
    assert_eq!(read_str(&mut p).unwrap(), "hello\n");
    assert_eq!(read(&mut p, 100), ReadResult::Block(None));
}

#[test]
fn canonical_read_returns_one_line_per_call() {
    let mut p = pty();
    typed(&mut p, "one\rtwo\r");
    assert_eq!(read_str(&mut p).unwrap(), "one\n");
    assert_eq!(read_str(&mut p).unwrap(), "two\n");
}

#[test]
fn short_buffer_gets_the_line_in_pieces() {
    let mut p = pty();
    typed(&mut p, "abcdef\r");
    let mut buf = [0u8; 4];
    assert_eq!(p.read(&mut buf, 0.0), ReadResult::Data(4));
    assert_eq!(&buf, b"abcd");
    assert_eq!(p.read(&mut buf, 0.0), ReadResult::Data(3));
    assert_eq!(&buf[..3], b"ef\n");
}

#[test]
fn echo_shows_typed_characters_and_crlf_for_enter() {
    let mut p = pty();
    typed(&mut p, "hi\r");
    assert_eq!(out(&mut p), "hi\r\n");
}

#[test]
fn echo_off_hides_input_but_echonl_still_shows_newline() {
    let mut p = pty();
    set(&mut p, |t| {
        t.lflag &= !ECHO;
        t.lflag |= ECHONL;
    });
    typed(&mut p, "secret\r");
    assert_eq!(out(&mut p), "\r\n");
    assert_eq!(read_str(&mut p).unwrap(), "secret\n");
}

#[test]
fn erase_removes_last_char_and_rubs_it_out() {
    let mut p = pty();
    typed(&mut p, "abc\x7f");
    assert_eq!(out(&mut p), "abc\x08 \x08");
    typed(&mut p, "d\r");
    assert_eq!(read_str(&mut p).unwrap(), "abd\n");
}

#[test]
fn erase_on_empty_line_does_nothing() {
    let mut p = pty();
    typed(&mut p, "\x7f\x7f");
    assert_eq!(out(&mut p), "");
    typed(&mut p, "a\r");
    out(&mut p);
    // The committed line is no longer editable.
    typed(&mut p, "\x7f");
    assert_eq!(out(&mut p), "");
    assert_eq!(read_str(&mut p).unwrap(), "a\n");
}

#[test]
fn erase_without_echoe_echoes_the_erase_char() {
    let mut p = pty();
    set(&mut p, |t| t.lflag &= !ECHOE);
    typed(&mut p, "ab\x7f");
    assert_eq!(out(&mut p), "ab^?");
    typed(&mut p, "\r");
    assert_eq!(read_str(&mut p).unwrap(), "a\n");
}

#[test]
fn erase_removes_a_whole_utf8_character() {
    let mut p = pty();
    typed(&mut p, "aé\x7f");
    assert_eq!(out(&mut p), "aé\x08 \x08");
    typed(&mut p, "\r");
    assert_eq!(read_str(&mut p).unwrap(), "a\n");
}

#[test]
fn erasing_a_control_char_rubs_out_both_caret_columns() {
    let mut p = pty();
    typed(&mut p, "a\x01\x7f");
    assert_eq!(out(&mut p), "a^A\x08 \x08\x08 \x08");
}

#[test]
fn erasing_a_tab_backs_up_to_where_it_started() {
    let mut p = pty();
    typed(&mut p, "ab\t");
    out(&mut p);
    typed(&mut p, "\x7f");
    // The tab advanced from column 2 to 8: six backspaces, no blanks.
    assert_eq!(out(&mut p), "\x08".repeat(6));
}

#[test]
fn tab_erase_accounts_for_the_prompt_column() {
    let mut p = pty();
    p.write(b"> ");
    out(&mut p);
    typed(&mut p, "\t\x7f");
    // Prompt ends at column 2, so the tab spanned 6 columns.
    assert_eq!(out(&mut p), format!("\t{}", "\x08".repeat(6)));
}

#[test]
fn kill_erases_the_whole_line() {
    let mut p = pty();
    typed(&mut p, "abc");
    out(&mut p);
    typed(&mut p, "\x15");
    assert_eq!(out(&mut p), "\x08 \x08".repeat(3));
    typed(&mut p, "x\r");
    assert_eq!(read_str(&mut p).unwrap(), "x\n");
}

#[test]
fn kill_without_echoke_echoes_caret_u_and_newline() {
    let mut p = pty();
    set(&mut p, |t| t.lflag &= !ECHOKE);
    typed(&mut p, "abc");
    out(&mut p);
    typed(&mut p, "\x15");
    assert_eq!(out(&mut p), "^U\r\n");
    typed(&mut p, "\r");
    assert_eq!(read_str(&mut p).unwrap(), "\n");
}

#[test]
fn werase_removes_trailing_blanks_then_one_word() {
    let mut p = pty();
    typed(&mut p, "foo bar  ");
    out(&mut p);
    typed(&mut p, "\x17");
    assert_eq!(out(&mut p), "\x08 \x08".repeat(5));
    typed(&mut p, "\r");
    assert_eq!(read_str(&mut p).unwrap(), "foo \n");
}

#[test]
fn eof_on_empty_line_reads_as_zero_bytes() {
    let mut p = pty();
    typed(&mut p, "\x04");
    assert_eq!(out(&mut p), "", "^D is not echoed");
    assert_eq!(read(&mut p, 100), ReadResult::Data(0));
    // EOF is not sticky.
    assert_eq!(read(&mut p, 100), ReadResult::Block(None));
}

#[test]
fn eof_mid_line_pushes_the_partial_line_without_newline() {
    let mut p = pty();
    typed(&mut p, "abc\x04");
    assert_eq!(read_str(&mut p).unwrap(), "abc");
    assert_eq!(read(&mut p, 100), ReadResult::Block(None));
}

#[test]
fn eof_after_exactly_full_buffer_is_not_a_false_eof() {
    let mut p = pty();
    typed(&mut p, "abc\x04");
    let mut buf = [0u8; 3];
    assert_eq!(p.read(&mut buf, 0.0), ReadResult::Data(3));
    assert_eq!(p.read(&mut buf, 0.0), ReadResult::Block(None));
}

#[test]
fn newline_then_eof_is_a_real_eof() {
    let mut p = pty();
    typed(&mut p, "abc\r\x04");
    let mut buf = [0u8; 4];
    assert_eq!(p.read(&mut buf, 0.0), ReadResult::Data(4));
    assert_eq!(p.read(&mut buf, 0.0), ReadResult::Data(0));
}

#[test]
fn lnext_takes_the_next_char_literally() {
    let mut p = pty();
    typed(&mut p, "\x16\x03\r");
    assert_eq!(p.take_signals(), 0);
    assert_eq!(out(&mut p), "^\x08^C\r\n");
    assert_eq!(read_str(&mut p).unwrap(), "\x03\n");
}

#[test]
fn reprint_redraws_the_pending_line() {
    let mut p = pty();
    typed(&mut p, "abc");
    out(&mut p);
    typed(&mut p, "\x12");
    assert_eq!(out(&mut p), "^R\r\nabc");
}

#[test]
fn canonical_line_is_capped_and_newline_still_terminates_it() {
    let mut p = pty();
    set(&mut p, |t| t.lflag &= !ECHO);
    let long = "x".repeat(5000);
    typed(&mut p, &long);
    typed(&mut p, "\r");
    let line = read_str(&mut p).unwrap();
    assert_eq!(line.len(), 4096);
    assert!(line.ends_with('\n'));
}

// ---- signals ----------------------------------------------------------------

#[test]
fn intr_raises_sigint_echoes_caret_c_and_discards_the_line() {
    let mut p = pty();
    typed(&mut p, "abc");
    out(&mut p);
    typed(&mut p, "\x03");
    assert_eq!(p.take_signals(), 1 << SIGINT);
    assert_eq!(out(&mut p), "^C");
    typed(&mut p, "\r");
    assert_eq!(read_str(&mut p).unwrap(), "\n");
}

#[test]
fn quit_and_susp_raise_sigquit_and_sigtstp() {
    let mut p = pty();
    typed(&mut p, "\x1c");
    assert_eq!(p.take_signals(), 1 << SIGQUIT);
    assert_eq!(out(&mut p), "^\\");
    typed(&mut p, "\x1a");
    assert_eq!(p.take_signals(), 1 << SIGTSTP);
    assert_eq!(out(&mut p), "^Z");
}

#[test]
fn signal_flushes_unread_committed_input_too() {
    let mut p = pty();
    typed(&mut p, "queued\r\x03");
    assert_eq!(read(&mut p, 100), ReadResult::Block(None));
}

#[test]
fn noflsh_keeps_input_across_a_signal() {
    let mut p = pty();
    set(&mut p, |t| t.lflag |= NOFLSH);
    typed(&mut p, "ab\x03c\r");
    assert_eq!(p.take_signals(), 1 << SIGINT);
    assert_eq!(read_str(&mut p).unwrap(), "abc\n");
}

#[test]
fn without_isig_the_interrupt_char_is_ordinary_input() {
    let mut p = pty();
    set(&mut p, |t| t.lflag &= !ISIG);
    typed(&mut p, "\x03\r");
    assert_eq!(p.take_signals(), 0);
    assert_eq!(read_str(&mut p).unwrap(), "\x03\n");
}

#[test]
fn disabled_control_char_never_matches() {
    let mut p = pty();
    set(&mut p, |t| t.cc[VINTR] = VDISABLE);
    typed(&mut p, "\x03\0\r");
    assert_eq!(p.take_signals(), 0);
    assert_eq!(read_str(&mut p).unwrap(), "\x03\0\n");
}

// ---- raw mode ---------------------------------------------------------------

#[test]
fn raw_mode_delivers_bytes_untouched_and_unechoed() {
    let mut p = pty();
    raw(&mut p);
    typed(&mut p, "a\r\x03\x7f\x04\x1b[A");
    assert_eq!(out(&mut p), "");
    assert_eq!(p.take_signals(), 0);
    assert_eq!(read_str(&mut p).unwrap(), "a\r\x03\x7f\x04\x1b[A");
}

#[test]
fn raw_mode_passes_terminal_protocol_bytes_through() {
    let mut p = pty();
    raw(&mut p);
    // bracketed paste, SGR mouse, focus in/out, kitty keyboard, 8-bit bytes
    let seq = "\x1b[200~pa\tste\r\n\x1b[201~\x1b[<0;10;5M\x1b[<0;10;5m\x1b[I\x1b[O\x1b[97;5u\u{e9}";
    typed(&mut p, seq);
    assert_eq!(read_str(&mut p).unwrap(), seq);
}

#[test]
fn vmin_one_blocks_until_a_byte_arrives() {
    let mut p = pty();
    raw(&mut p);
    assert_eq!(read(&mut p, 10), ReadResult::Block(None));
    assert!(!p.poll_in());
    typed(&mut p, "x");
    assert!(p.poll_in());
    assert_eq!(read(&mut p, 10), ReadResult::Data(1));
}

#[test]
fn vmin_three_waits_for_three_bytes_or_a_full_buffer() {
    let mut p = pty();
    raw(&mut p);
    set(&mut p, |t| t.cc[VMIN] = 3);
    typed(&mut p, "ab");
    assert_eq!(read(&mut p, 10), ReadResult::Block(None));
    assert!(!p.poll_in());
    // A 2-byte buffer is satisfied by 2 bytes.
    assert_eq!(read(&mut p, 2), ReadResult::Data(2));
    typed(&mut p, "abc");
    assert_eq!(read(&mut p, 10), ReadResult::Data(3));
}

#[test]
fn vmin_zero_vtime_zero_is_a_nonblocking_read() {
    let mut p = pty();
    raw(&mut p);
    set(&mut p, |t| {
        t.cc[VMIN] = 0;
        t.cc[VTIME] = 0;
    });
    assert_eq!(read(&mut p, 10), ReadResult::Data(0));
    typed(&mut p, "x");
    assert_eq!(read(&mut p, 10), ReadResult::Data(1));
}

#[test]
fn vmin_zero_vtime_is_a_read_timeout() {
    let mut p = pty();
    raw(&mut p);
    set(&mut p, |t| {
        t.cc[VMIN] = 0;
        t.cc[VTIME] = 5; // 500 ms
    });
    let mut buf = [0u8; 10];
    p.read_begin(1000.0);
    assert_eq!(p.read(&mut buf, 1000.0), ReadResult::Block(Some(1500.0)));
    assert_eq!(p.read(&mut buf, 1499.0), ReadResult::Block(Some(1500.0)));
    assert_eq!(p.read(&mut buf, 1500.0), ReadResult::Data(0));
    p.read_begin(2000.0);
    p.master_write(b"k", 2100.0);
    assert_eq!(p.read(&mut buf, 2100.0), ReadResult::Data(1));
}

#[test]
fn vmin_with_vtime_is_an_interbyte_timer_that_starts_at_the_first_byte() {
    let mut p = pty();
    raw(&mut p);
    set(&mut p, |t| {
        t.cc[VMIN] = 5;
        t.cc[VTIME] = 2; // 200 ms
    });
    let mut buf = [0u8; 10];
    p.read_begin(0.0);
    // No byte yet: waits forever, the timer has not started.
    assert_eq!(p.read(&mut buf, 10_000.0), ReadResult::Block(None));
    p.master_write(b"a", 10_000.0);
    assert_eq!(p.read(&mut buf, 10_050.0), ReadResult::Block(Some(10_200.0)));
    // Another byte restarts the timer.
    p.master_write(b"b", 10_150.0);
    assert_eq!(p.read(&mut buf, 10_250.0), ReadResult::Block(Some(10_350.0)));
    assert_eq!(p.read(&mut buf, 10_350.0), ReadResult::Data(2));
}

#[test]
fn switching_to_raw_makes_a_half_typed_line_readable() {
    let mut p = pty();
    typed(&mut p, "par");
    assert_eq!(read(&mut p, 10), ReadResult::Block(None));
    raw(&mut p);
    assert_eq!(read_str(&mut p).unwrap(), "par");
}

#[test]
fn switching_to_canonical_turns_pending_bytes_into_a_complete_line() {
    let mut p = pty();
    raw(&mut p);
    typed(&mut p, "abc");
    set(&mut p, |t| t.lflag |= ICANON);
    assert_eq!(read_str(&mut p).unwrap(), "abc");
    assert_eq!(read(&mut p, 10), ReadResult::Block(None));
}

#[test]
fn tcsaflush_discards_pending_input() {
    let mut p = pty();
    typed(&mut p, "typed ahead\r");
    let t = p.termios();
    p.set_termios(TCSAFLUSH, t);
    assert_eq!(read(&mut p, 100), ReadResult::Block(None));
}

// ---- input / output flags -----------------------------------------------

#[test]
fn input_cr_nl_mappings() {
    let mut p = pty();
    raw(&mut p);
    typed(&mut p, "\r");
    assert_eq!(read_str(&mut p).unwrap(), "\r");
    set(&mut p, |t| t.iflag |= ICRNL);
    typed(&mut p, "\r");
    assert_eq!(read_str(&mut p).unwrap(), "\n");
    set(&mut p, |t| {
        t.iflag &= !ICRNL;
        t.iflag |= INLCR;
    });
    typed(&mut p, "\n");
    assert_eq!(read_str(&mut p).unwrap(), "\r");
    set(&mut p, |t| {
        t.iflag &= !INLCR;
        t.iflag |= IGNCR | ICRNL;
    });
    typed(&mut p, "a\rb");
    assert_eq!(read_str(&mut p).unwrap(), "ab");
}

#[test]
fn onlcr_turns_program_newlines_into_crlf() {
    let mut p = pty();
    p.write(b"a\nb\n");
    assert_eq!(out(&mut p), "a\r\nb\r\n");
}

#[test]
fn without_opost_output_is_untouched() {
    let mut p = pty();
    set(&mut p, |t| t.oflag &= !OPOST);
    p.write(b"a\nb\t\x1b[2J");
    assert_eq!(out(&mut p), "a\nb\t\x1b[2J");
}

#[test]
fn opost_without_onlcr_leaves_newlines_alone() {
    let mut p = pty();
    set(&mut p, |t| t.oflag &= !ONLCR);
    p.write(b"a\n");
    assert_eq!(out(&mut p), "a\n");
}

#[test]
fn ocrnl_and_onocr() {
    let mut p = pty();
    set(&mut p, |t| t.oflag |= OCRNL);
    p.write(b"a\r");
    assert_eq!(out(&mut p), "a\n");
    let mut p = pty();
    set(&mut p, |t| t.oflag |= ONOCR);
    p.write(b"\rb\r");
    // CR at column 0 is dropped, CR at column 1 is kept.
    assert_eq!(out(&mut p), "b\r");
}

#[test]
fn xtabs_expands_tabs_to_the_next_tab_stop() {
    let mut p = pty();
    set(&mut p, |t| t.oflag |= XTABS);
    p.write(b"ab\tc");
    assert_eq!(out(&mut p), "ab      c");
}

#[test]
fn ixon_stop_and_start_hold_and_release_output() {
    let mut p = pty();
    typed(&mut p, "\x13");
    p.write(b"held");
    assert_eq!(out(&mut p), "");
    assert_eq!(p.master_pending(), 0);
    typed(&mut p, "\x11");
    assert_eq!(out(&mut p), "held");
    // Neither character reaches the program.
    typed(&mut p, "\r");
    assert_eq!(read_str(&mut p).unwrap(), "\n");
}

#[test]
fn echoctl_off_echoes_control_chars_raw() {
    let mut p = pty();
    set(&mut p, |t| t.lflag &= !ECHOCTL);
    typed(&mut p, "\x01");
    assert_eq!(out(&mut p), "\x01");
}

#[test]
fn raw_mode_with_echo_echoes_without_line_editing() {
    let mut p = pty();
    raw(&mut p);
    set(&mut p, |t| t.lflag |= ECHO | ECHOCTL);
    typed(&mut p, "a\x7f");
    assert_eq!(out(&mut p), "a^?");
    assert_eq!(read_str(&mut p).unwrap(), "a\x7f");
}

// ---- window size / hangup / struct layout -----------------------------------

#[test]
fn resize_updates_winsize_and_raises_sigwinch_once_per_change() {
    let mut p = pty();
    assert_eq!(p.winsize(), Winsize { row: 24, col: 80, xpixel: 0, ypixel: 0 });
    p.set_winsize(Winsize { row: 40, col: 120, xpixel: 960, ypixel: 640 });
    assert_eq!(p.take_signals(), 1 << SIGWINCH);
    assert_eq!(p.winsize().col, 120);
    p.set_winsize(Winsize { row: 40, col: 120, xpixel: 960, ypixel: 640 });
    assert_eq!(p.take_signals(), 0, "same size: no signal");
}

#[test]
fn hangup_gives_eof_and_sighup() {
    let mut p = pty();
    p.hangup();
    assert_eq!(p.take_signals(), 1 << SIGHUP);
    assert!(p.poll_in());
    assert_eq!(read(&mut p, 10), ReadResult::Data(0));
}

#[test]
fn termios_wire_layout_round_trips() {
    let t = Termios::default();
    let b = t.to_bytes();
    assert_eq!(b.len(), 44);
    assert_eq!(u32::from_le_bytes([b[12], b[13], b[14], b[15]]), t.lflag);
    assert_eq!(b[16 + VINTR], 3);
    assert_eq!(b[16 + VMIN], 1);
    assert_eq!(Termios::from_bytes(&b), t);
    // Linux values, so libc-based code ports unchanged.
    assert_eq!((ICANON, ECHO, ISIG, IEXTEN), (0x2, 0x8, 0x1, 0x8000));
    assert_eq!((ICRNL, IXON, OPOST, ONLCR), (0x100, 0x400, 0x1, 0x4));
}
