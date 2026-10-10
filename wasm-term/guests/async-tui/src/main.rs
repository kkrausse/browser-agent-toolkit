//! The codex-shaped program: ratatui drawn through `CrosstermBackend`,
//! input from crossterm's async `EventStream`, a tokio `current_thread`
//! runtime, a WebSocket and a streamed HTTP response, all in one `select!`.
//!
//! Type a line and press Enter to send it over the WebSocket. F2 starts a
//! server-sent-event stream. Esc or Ctrl+C quits.

use std::collections::VecDeque;
use std::io::{self, stdout};
use std::time::Duration;

use crossterm::event::{
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture, Event, EventStream, KeyCode,
    KeyEventKind, KeyModifiers, MouseEventKind,
};
use crossterm::execute;
use crossterm::terminal::{self, EnterAlternateScreen, LeaveAlternateScreen};
use futures_util::StreamExt;
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Color, Stylize};
use ratatui::text::Line;
use ratatui::widgets::{Block, List, ListItem, Paragraph};
use ratatui::Terminal;
use tokio::sync::mpsc;
use wasm_term_tokio::{WebSocket, WsEvent};

struct App {
    input: String,
    log: VecDeque<Line<'static>>,
    ticks: u64,
    size: (u16, u16),
}

impl App {
    fn log(&mut self, source: &'static str, color: Color, text: String) {
        self.log.push_front(Line::from(vec![format!("{source:<6}").fg(color).bold(), text.into()]));
        self.log.truncate(100);
    }
}

async fn run(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>, origin: String) -> io::Result<()> {
    let mut app = App { input: String::new(), log: VecDeque::new(), ticks: 0, size: terminal::size()? };
    let mut events = EventStream::new();
    let mut ticker = tokio::time::interval(Duration::from_millis(100));
    let mut ws = WebSocket::connect(&format!("{}/test/ws", origin.replacen("http", "ws", 1)), &[])?;
    // The event stream runs as its own task and reports over a channel, the
    // way a real client keeps network work off the UI loop.
    let (sse_tx, mut sse_rx) = mpsc::unbounded_channel::<String>();

    loop {
        terminal.draw(|frame| {
            let [header, log, input] =
                Layout::vertical([Constraint::Length(1), Constraint::Min(3), Constraint::Length(3)]).areas(frame.area());
            let spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][app.ticks as usize % 10];
            frame.render_widget(
                Paragraph::new(Line::from(vec![
                    " async-tui ".bold().fg(Color::Black).bg(Color::LightCyan),
                    format!(" tokio current_thread + crossterm EventStream  {spinner} tick {}  {}x{} ", app.ticks, app.size.0, app.size.1).into(),
                ])),
                header,
            );
            let items: Vec<ListItem> = app.log.iter().take(log.height as usize).cloned().map(ListItem::new).collect();
            frame.render_widget(List::new(items).block(Block::bordered().title("events (newest first)")), log);
            frame.render_widget(
                Paragraph::new(format!("> {}█", app.input)).block(Block::bordered().title("Enter sends over the WebSocket · F2 event stream · Esc quits")),
                input,
            );
        })?;

        tokio::select! {
            _ = ticker.tick() => app.ticks += 1,
            event = events.next() => match event {
                None => return Ok(()),
                Some(Err(error)) => return Err(error),
                Some(Ok(Event::Key(key))) if key.kind != KeyEventKind::Release => match key.code {
                    KeyCode::Esc => return Ok(()),
                    KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => return Ok(()),
                    KeyCode::Char(c) => app.input.push(c),
                    KeyCode::Backspace => { app.input.pop(); }
                    KeyCode::Enter => {
                        let line = std::mem::take(&mut app.input);
                        ws.send_text(&line)?;
                        app.log("send", Color::LightYellow, line);
                    }
                    KeyCode::F(2) => {
                        let (tx, url) = (sse_tx.clone(), format!("{origin}/test/sse?count=5&interval=400"));
                        tokio::spawn(async move {
                            let result: io::Result<()> = async {
                                let mut response = wasm_term_tokio::http("GET", &url, &[], b"").await?;
                                let _ = tx.send(format!("status {}", response.status));
                                let mut buf = [0u8; 1024];
                                loop {
                                    let n = response.read(&mut buf).await?;
                                    if n == 0 { break; }
                                    let _ = tx.send(format!("{:?}", String::from_utf8_lossy(&buf[..n])));
                                }
                                let _ = tx.send("end of stream".into());
                                Ok(())
                            }.await;
                            if let Err(error) = result { let _ = tx.send(format!("error: {error}")); }
                        });
                    }
                    other => app.log("key", Color::LightGreen, format!("{other:?} {:?}", key.modifiers)),
                },
                Some(Ok(Event::Mouse(mouse))) => {
                    if !matches!(mouse.kind, MouseEventKind::Moved) {
                        app.log("mouse", Color::LightMagenta, format!("{:?} at ({}, {})", mouse.kind, mouse.column, mouse.row));
                    }
                }
                Some(Ok(Event::Paste(text))) => app.input.push_str(&text.replace('\n', " ")),
                Some(Ok(Event::Resize(cols, rows))) => {
                    app.size = (cols, rows);
                    app.log("resize", Color::LightCyan, format!("{cols}x{rows}"));
                }
                Some(Ok(_)) => {}
            },
            event = ws.recv() => {
                let event = event?;
                let finished = matches!(event, WsEvent::Close { .. } | WsEvent::Error(_));
                app.log("ws", Color::LightBlue, format!("{event:?}"));
                if finished {
                    terminal.draw(|_| {})?;
                    return Ok(());
                }
            }
            Some(line) = sse_rx.recv() => app.log("sse", Color::LightRed, line),
        }
    }
}

fn main() -> io::Result<()> {
    let origin = std::env::var("WASM_TERM_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:4790".into());
    terminal::enable_raw_mode()?;
    execute!(stdout(), EnterAlternateScreen, EnableMouseCapture, EnableBracketedPaste)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout()))?;

    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    let result = runtime.block_on(run(&mut terminal, origin));

    execute!(stdout(), DisableBracketedPaste, DisableMouseCapture, LeaveAlternateScreen)?;
    terminal::disable_raw_mode()?;
    println!("async-tui: done ({result:?})");
    result
}
