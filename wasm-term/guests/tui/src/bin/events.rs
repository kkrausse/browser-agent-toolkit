//! Prints every crossterm event, one per line, without a full-screen UI.
//! Handy for seeing what the crossterm wasi backend makes of terminal input.

use crossterm::event::{self, Event, KeyCode, KeyModifiers};
use crossterm::terminal;
use std::io::{self, Write};
use std::time::Duration;

fn main() -> io::Result<()> {
    terminal::enable_raw_mode()?;
    let mut out = io::stdout();
    write!(out, "crossterm events (size {:?}); q quits\r\n", terminal::size()?)?;
    out.flush()?;
    let mut idle = 0;
    loop {
        if !event::poll(Duration::from_secs(2))? {
            idle += 1;
            write!(out, "(no event for 2 s, #{idle})\r\n")?;
            out.flush()?;
            continue;
        }
        let event = event::read()?;
        write!(out, "{event:?}\r\n")?;
        out.flush()?;
        if let Event::Key(key) = event {
            if key.code == KeyCode::Char('q') || (key.code == KeyCode::Char('c') && key.modifiers == KeyModifiers::CONTROL) {
                break;
            }
        }
    }
    terminal::disable_raw_mode()
}
