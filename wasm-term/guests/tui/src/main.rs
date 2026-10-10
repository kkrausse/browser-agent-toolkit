//! Raw-mode ratatui app on the stock `CrosstermBackend`.
//!
//! Exercises everything a full-screen TUI needs from the machine: raw mode,
//! alternate screen, colours, keyboard (with kitty enhancements), mouse,
//! bracketed paste, focus reports, resize, and an animation driven by a timer
//! that is multiplexed with input through `crossterm::event::poll`.

use std::collections::VecDeque;
use std::io::{self, stdout};
use std::time::{Duration, Instant};

use crossterm::event::{
    self, DisableBracketedPaste, DisableFocusChange, DisableMouseCapture, EnableBracketedPaste, EnableFocusChange,
    EnableMouseCapture, Event, KeyCode, KeyEventKind, KeyModifiers, KeyboardEnhancementFlags, MouseButton,
    MouseEventKind, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use crossterm::execute;
use crossterm::terminal::{self, EnterAlternateScreen, LeaveAlternateScreen};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Layout, Position, Rect};
use ratatui::style::{Color, Modifier, Style, Stylize};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Gauge, List, ListItem, Paragraph, Sparkline};
use ratatui::{Frame, Terminal};

const TICK: Duration = Duration::from_millis(50);

struct App {
    started: Instant,
    ticks: u64,
    paused: bool,
    focused: bool,
    keyboard_enhanced: bool,
    size: (u16, u16),
    resizes: u32,
    log: VecDeque<String>,
    /// Cells the user clicked or dragged over, in terminal coordinates.
    marks: Vec<(u16, u16, Color)>,
    pause_button: Rect,
    clear_button: Rect,
    wave: Vec<u64>,
}

impl App {
    fn log(&mut self, entry: String) {
        self.log.push_front(entry);
        self.log.truncate(200);
    }

    fn on_tick(&mut self) {
        if self.paused {
            return;
        }
        self.ticks += 1;
        let t = self.ticks as f64 / 6.0;
        self.wave.push(((t.sin() * 0.5 + 0.5) * 40.0 + (t * 2.7).cos().abs() * 20.0) as u64);
        if self.wave.len() > 400 {
            self.wave.remove(0);
        }
    }

    /// Returns false when the app should quit.
    fn on_event(&mut self, event: Event) -> bool {
        match event {
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                self.log(format!("key    {:?} {:?} {:?}", key.code, key.modifiers, key.kind));
                match key.code {
                    KeyCode::Char('q') | KeyCode::Esc => return false,
                    KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => return false,
                    KeyCode::Char(' ') => self.paused = !self.paused,
                    KeyCode::Char('x') => self.marks.clear(),
                    _ => {}
                }
            }
            Event::Key(_) => {}
            Event::Mouse(mouse) => {
                let at = Position::new(mouse.column, mouse.row);
                match mouse.kind {
                    MouseEventKind::Moved => return true, // not logged: too chatty
                    MouseEventKind::Down(MouseButton::Left) if self.pause_button.contains(at) => {
                        self.paused = !self.paused;
                    }
                    MouseEventKind::Down(MouseButton::Left) if self.clear_button.contains(at) => self.marks.clear(),
                    MouseEventKind::Down(button) => {
                        let color = match button {
                            MouseButton::Left => Color::LightMagenta,
                            MouseButton::Right => Color::LightCyan,
                            MouseButton::Middle => Color::LightYellow,
                        };
                        self.marks.push((mouse.column, mouse.row, color));
                    }
                    MouseEventKind::Drag(_) => self.marks.push((mouse.column, mouse.row, Color::LightGreen)),
                    _ => {}
                }
                self.log(format!("mouse  {:?} at ({}, {}) {:?}", mouse.kind, mouse.column, mouse.row, mouse.modifiers));
            }
            Event::Paste(text) => self.log(format!("paste  {} chars: {:?}", text.chars().count(), text)),
            Event::FocusGained => {
                self.focused = true;
                self.log("focus  gained".into());
            }
            Event::FocusLost => {
                self.focused = false;
                self.log("focus  lost".into());
            }
            Event::Resize(cols, rows) => {
                self.size = (cols, rows);
                self.resizes += 1;
                self.log(format!("resize {cols}x{rows}"));
            }
        }
        true
    }

    fn draw(&mut self, frame: &mut Frame) {
        let area = frame.area();
        let [header, body, footer] =
            Layout::vertical([Constraint::Length(3), Constraint::Min(8), Constraint::Length(1)]).areas(area);
        let [left, right] = Layout::horizontal([Constraint::Percentage(45), Constraint::Percentage(55)]).areas(body);
        let [animation, colors, buttons] =
            Layout::vertical([Constraint::Length(9), Constraint::Min(6), Constraint::Length(3)]).areas(left);

        // Header: live facts about the machine.
        let seconds = self.started.elapsed().as_secs_f64();
        let title = Line::from(vec![
            " wasm-term ".bold().fg(Color::Black).bg(Color::LightGreen),
            " ratatui on CrosstermBackend ".into(),
            format!(" {}x{} ", self.size.0, self.size.1).fg(Color::LightYellow),
            format!(" resizes {} ", self.resizes).fg(Color::LightCyan),
            if self.focused { " focused ".fg(Color::LightGreen) } else { " unfocused ".fg(Color::LightRed) },
            if self.keyboard_enhanced { " kitty-keys ".fg(Color::LightMagenta) } else { " legacy-keys ".fg(Color::DarkGray) },
            format!(" tick {} ", self.ticks).into(),
            format!(" {seconds:.1}s ").fg(Color::DarkGray),
        ]);
        frame.render_widget(Paragraph::new(title).block(Block::bordered().title("machine")), header);

        // Animation: a timer-driven spinner, gauge and scrolling wave.
        let spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][(self.ticks as usize / 2) % 10];
        let block = Block::bordered().title(format!("{spinner} animation ({} ms timer)", TICK.as_millis()));
        let inner = block.inner(animation);
        frame.render_widget(block, animation);
        let [gauge_area, wave_area, ball_area] =
            Layout::vertical([Constraint::Length(1), Constraint::Min(3), Constraint::Length(1)]).areas(inner);
        let ratio = (self.ticks % 100) as f64 / 100.0;
        frame.render_widget(
            Gauge::default().ratio(ratio).gauge_style(Style::new().fg(Color::Rgb(255, (ratio * 200.0) as u8, 80)).bg(Color::Rgb(30, 30, 40))),
            gauge_area,
        );
        let visible = wave_area.width as usize;
        let start = self.wave.len().saturating_sub(visible);
        frame.render_widget(Sparkline::default().data(&self.wave[start..]).style(Style::new().fg(Color::LightBlue)), wave_area);
        let span = ball_area.width.saturating_sub(1).max(1) as u64;
        let phase = self.ticks % (span * 2);
        let x = if phase < span { phase } else { span * 2 - phase } as u16;
        frame.render_widget(Paragraph::new("●").fg(Color::LightRed), Rect::new(ball_area.x + x, ball_area.y, 1, 1));

        // Colours: 16-colour, 256-colour and 24-bit, plus text attributes.
        let block = Block::bordered().title("colours");
        let inner = block.inner(colors);
        frame.render_widget(block, colors);
        let mut lines = vec![
            Line::from((0..16).map(|i| Span::styled("  ", Style::new().bg(Color::Indexed(i)))).collect::<Vec<_>>()),
            Line::from((0..inner.width).map(|i| Span::styled(" ", Style::new().bg(Color::Indexed(16 + (i % 216) as u8)))).collect::<Vec<_>>()),
            Line::from(
                (0..inner.width)
                    .map(|i| {
                        let t = i as f32 / inner.width.max(1) as f32;
                        let shift = (self.ticks % 120) as f32 / 120.0;
                        let hue = (t + shift).fract() * 6.0;
                        let c = |offset: f32| (((hue + offset).rem_euclid(6.0) - 3.0).abs() - 1.0).clamp(0.0, 1.0);
                        Span::styled("▀", Style::new().fg(Color::Rgb((c(0.0) * 255.0) as u8, (c(2.0) * 255.0) as u8, (c(4.0) * 255.0) as u8)).bg(Color::Rgb((t * 255.0) as u8, 40, 255 - (t * 255.0) as u8)))
                    })
                    .collect::<Vec<_>>(),
            ),
        ];
        lines.push(Line::from(vec![
            "bold ".bold(),
            "italic ".italic(),
            "underline ".underlined(),
            "reverse".reversed(),
            " ".into(),
            "dim ".dim(),
            "strike".crossed_out(),
        ]));
        lines.push(Line::from("日本語 wide · é combining · ✓ ░▒▓█ box ┌─┐"));
        frame.render_widget(Paragraph::new(lines), inner);

        // Buttons: mouse targets.
        let [pause, clear, _] =
            Layout::horizontal([Constraint::Length(18), Constraint::Length(16), Constraint::Min(0)]).areas(buttons);
        self.pause_button = pause;
        self.clear_button = clear;
        let label = if self.paused { "▶ resume" } else { "⏸ pause" };
        frame.render_widget(
            Paragraph::new(label).centered().block(Block::bordered()).style(Style::new().fg(Color::Black).bg(if self.paused { Color::LightYellow } else { Color::LightGreen })),
            pause,
        );
        frame.render_widget(Paragraph::new("✗ clear marks").centered().block(Block::bordered()), clear);

        // Event log.
        let items: Vec<ListItem> = self
            .log
            .iter()
            .take(right.height.saturating_sub(2) as usize)
            .enumerate()
            .map(|(index, entry)| {
                let style = if index == 0 { Style::new().fg(Color::White).add_modifier(Modifier::BOLD) } else { Style::new().fg(Color::Gray) };
                ListItem::new(entry.as_str()).style(style)
            })
            .collect();
        frame.render_widget(List::new(items).block(Block::bordered().title("events (newest first)")), right);

        frame.render_widget(
            Paragraph::new(" q/Esc/Ctrl+C quit · Space pause · x clear · click/drag anywhere · paste · resize the window ").fg(Color::DarkGray),
            footer,
        );

        // Marks left by the mouse, drawn last so they sit on top.
        for &(column, row, color) in &self.marks {
            if column < area.width && row < area.height {
                frame.render_widget(Paragraph::new("◆").fg(color), Rect::new(column, row, 1, 1));
            }
        }
    }
}

fn run(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>, keyboard_enhanced: bool) -> io::Result<()> {
    let mut app = App {
        started: Instant::now(),
        ticks: 0,
        paused: false,
        focused: true,
        keyboard_enhanced,
        size: terminal::size()?,
        resizes: 0,
        log: VecDeque::new(),
        marks: Vec::new(),
        pause_button: Rect::default(),
        clear_button: Rect::default(),
        wave: Vec::new(),
    };
    let mut next_tick = Instant::now() + TICK;
    loop {
        terminal.draw(|frame| app.draw(frame))?;
        // One wait covers both input and the animation timer.
        let timeout = next_tick.saturating_duration_since(Instant::now());
        if event::poll(timeout)? {
            // Drain everything that is ready before redrawing.
            loop {
                if !app.on_event(event::read()?) {
                    return Ok(());
                }
                if !event::poll(Duration::ZERO)? {
                    break;
                }
            }
        }
        if Instant::now() >= next_tick {
            app.on_tick();
            next_tick += TICK;
            // After a long stall (hidden tab), do not replay the missed ticks.
            if next_tick < Instant::now() {
                next_tick = Instant::now() + TICK;
            }
        }
    }
}

fn main() -> io::Result<()> {
    terminal::enable_raw_mode()?;
    // Asks the terminal (CSI ? u) and waits for its reply on stdin.
    let keyboard_enhanced = terminal::supports_keyboard_enhancement().unwrap_or(false);
    execute!(stdout(), EnterAlternateScreen, EnableMouseCapture, EnableBracketedPaste, EnableFocusChange)?;
    if keyboard_enhanced {
        execute!(stdout(), PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES))?;
    }
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout()))?;
    let cursor = crossterm::cursor::position();

    let result = run(&mut terminal, keyboard_enhanced);

    if keyboard_enhanced {
        execute!(stdout(), PopKeyboardEnhancementFlags)?;
    }
    execute!(stdout(), DisableFocusChange, DisableBracketedPaste, DisableMouseCapture, LeaveAlternateScreen)?;
    terminal::disable_raw_mode()?;
    println!("tui: left the alternate screen and restored cooked mode.");
    println!("tui: keyboard enhancement supported: {keyboard_enhanced}; cursor position query: {cursor:?}");
    result
}
