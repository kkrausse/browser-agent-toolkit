mod app;
mod deps;
mod modules;
mod pack;
mod policy;
mod program;
mod tree;

use anyhow::{bail, Result};
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::time::Instant;

#[derive(Parser)]
#[command(name = "bat-prepare", about = "Prepare guest images for the browser dev environment")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Pack directory trees into one image.
    Pack {
        /// `<dir>` (contents go to the image root) or `<dir>=<sub/path>` (contents go under that path).
        #[arg(required = true)]
        dirs: Vec<String>,
        /// Guest path the image root is mounted at.
        #[arg(long, default_value = "/")]
        root: String,
        #[arg(short, long)]
        out: PathBuf,
        /// Read every entry back and compare with the inputs.
        #[arg(long)]
        verify: bool,
        /// Body alignment as a power of two.
        #[arg(long, default_value_t = 4)]
        align_log2: u32,
    },
    /// Prepare an app end to end: guest dependencies + application → image, program
    /// scripts and manifest.json in `--out`. Unchanged inputs reuse the image.
    App {
        /// App directory containing package.json and bun.lock.
        app: PathBuf,
        #[arg(short, long)]
        out: PathBuf,
        /// Scratch and cache directory (default: `<out>.work`).
        #[arg(long)]
        work: Option<PathBuf>,
        /// App-relative file or directory delivered as editable source (repeatable).
        #[arg(long)]
        source: Vec<String>,
        /// Extra project file `<workspace-relative guest path>=<host file>` (repeatable).
        #[arg(long)]
        file: Vec<String>,
        /// Guest policy JSON (default: the embedded data/guest-policy.json).
        #[arg(long)]
        policy: Option<PathBuf>,
        /// Directory with the application files the policy pins (OpenCode `server.js`, wasm).
        #[arg(long, env = "BAT_OPENCODE_DIR")]
        opencode: Option<PathBuf>,
        #[arg(long, default_value = "/workspace")]
        workspace: String,
        #[arg(long, default_value = "bun", env = "BAT_BUN")]
        bun: String,
        /// Rebuild the image even if the inputs are unchanged.
        #[arg(long)]
        force: bool,
        /// After building, read every entry back through the reader and compare.
        #[arg(long)]
        verify: bool,
        /// JSON merged over the policy's preview launch description.
        #[arg(long)]
        preview: Option<String>,
        /// Start-up order file (see `order`): those bodies are laid out first in the
        /// image, so a first open can start while the rest still downloads.
        #[arg(long)]
        order: Option<PathBuf>,
        /// zstd level (1..=19) of the copy browsers download. 19 is about 14% smaller
        /// than 9 and takes tens of seconds per image instead of two.
        #[arg(long, default_value_t = 9, env = "BAT_ZSTD_LEVEL")]
        zstd_level: i32,
    },
    /// Turn a recorded access trace (JSON `[[offset, length], …]` of reads from `image`,
    /// in first-access order, as the runtime dumps it) into a start-up order file for
    /// `app --order`: one `<b|c|bc>\t<guest path>` per line.
    Order {
        image: PathBuf,
        trace: PathBuf,
        /// Guest path the image is mounted at.
        #[arg(long, default_value = "/")]
        root: String,
    },
    /// Produce only the pruned guest node_modules tree in `--work` and report sizes.
    Deps {
        app: PathBuf,
        #[arg(long)]
        work: PathBuf,
        #[arg(long)]
        policy: Option<PathBuf>,
        #[arg(long, default_value = "bun", env = "BAT_BUN")]
        bun: String,
    },
    /// Every entry as TSV: kind, mode, size, body offset, compiled offset, compiled length,
    /// facts word (hex), facts blob length, path, symlink target.
    List { image: PathBuf },
    /// Write one file's body (or its compiled body / facts blob) to stdout.
    Cat {
        image: PathBuf,
        path: String,
        #[arg(long)]
        compiled: bool,
        #[arg(long)]
        facts: bool,
    },
    /// Print the embedded guest policy.
    Policy,
    /// Print the header and, with a path, list a directory or describe an entry.
    Info {
        image: PathBuf,
        path: Option<String>,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Pack { dirs, root, out, verify, align_log2 } => {
            let started = Instant::now();
            let mut items = Vec::new();
            for spec in &dirs {
                let (dir, prefix) = match spec.split_once('=') {
                    Some((dir, prefix)) => (dir, prefix.trim_matches('/')),
                    None => (spec.as_str(), ""),
                };
                tree::walk(dir.as_ref(), prefix, &mut items)?;
            }
            let walk_ms = started.elapsed().as_millis();
            let stats = pack::write_image(&items, pack::PackOptions { root, transform: None, sections: vec![], align_log2, program_modules: Default::default(), first: vec![] }, &out)?.stats;
            let total_ms = started.elapsed().as_millis();
            println!("{}", serde_json::to_string_pretty(&stats)?);
            eprintln!("packed {} entries, {} bytes in {total_ms} ms (walk {walk_ms} ms)", stats.entries, stats.image_bytes);
            if verify {
                let started = Instant::now();
                let compared = pack::verify_image(&out, &items)?;
                eprintln!("verified {} entries, {compared} file bodies in {} ms", items.len(), started.elapsed().as_millis());
            }
            Ok(())
        }
        Command::Info { image, path } => info(&image, path.as_deref()),
        Command::List { image } => {
            use std::io::Write;
            let file = bat_image::writer::ImageFile::open(&image)?;
            let image = file.image();
            let mut out = std::io::BufWriter::new(std::io::stdout().lock());
            for index in 0..image.len() {
                let e = image.entry(index);
                let kind = match e.kind {
                    bat_image::Kind::File => 'f',
                    bat_image::Kind::Dir => 'd',
                    bat_image::Kind::Symlink => 'l',
                };
                writeln!(
                    out,
                    "{kind}\t{:o}\t{}\t{}\t{}\t{}\t{:x}\t{}\t/{}\t{}",
                    e.mode,
                    e.size(),
                    e.body().map_or(0, |b| b.offset),
                    e.compiled().map_or(0, |b| b.offset),
                    e.compiled().map_or(0, |b| b.len),
                    e.facts,
                    e.facts_blob().map_or(0, |b| b.len),
                    String::from_utf8_lossy(e.path),
                    String::from_utf8_lossy(e.target().unwrap_or_default()),
                )?;
            }
            Ok(())
        }
        Command::Cat { image, path, compiled, facts } => {
            use std::io::Write;
            let file = bat_image::writer::ImageFile::open(&image)?;
            // Symlinks are followed, as the guest would.
            let Some(index) = file.image().resolve(bat_image::Image::ROOT, path.trim_matches('/').as_bytes(), true) else { bail!("not found: {path}") };
            let bytes = if compiled {
                file.read_compiled(index)?.ok_or_else(|| anyhow::anyhow!("no compiled body: {path}"))?
            } else if facts {
                file.read_facts_blob(index)?.unwrap_or_default()
            } else {
                file.read_body(index)?
            };
            std::io::stdout().write_all(&bytes)?;
            Ok(())
        }
        Command::Policy => {
            print!("{}", policy::DEFAULT_POLICY);
            Ok(())
        }
        Command::Deps { app, work, policy, bun } => {
            let (policy, _) = policy::load(policy.as_deref())?;
            let pinned = match &policy.application {
                Some(application) => application.pinned()?,
                None => vec![],
            };
            std::fs::create_dir_all(&work)?;
            let deps = deps::prepare(deps::DepsOptions { app: &app, work: &work, policy: &policy, bun: &bun, application_files: &pinned })?;
            println!("{}", serde_json::to_string_pretty(&serde_json::json!({ "nodeModules": deps.node_modules, "report": deps.report }))?);
            Ok(())
        }
        Command::Order { image, trace, root } => order(&image, &trace, &root),
        Command::App { app, out, work, source, file, policy, opencode, workspace, bun, force, verify, preview, order, zstd_level } => {
            let work = work.unwrap_or_else(|| {
                let mut name = out.file_name().unwrap_or_default().to_os_string();
                name.push(".work");
                out.with_file_name(name)
            });
            let files = file
                .iter()
                .map(|spec| spec.split_once('=').map(|(guest, host)| (guest.to_string(), PathBuf::from(host))).ok_or_else(|| anyhow::anyhow!("--file expects <guest path>=<host file>: {spec}")))
                .collect::<Result<Vec<_>>>()?;
            let preview = preview.map(|text| serde_json::from_str(&text)).transpose()?;
            let summary = app::prepare_app(app::AppOptions { app, out, work, source, files, policy, application_dir: opencode, workspace, bun, force, verify, preview, order, zstd_level })?;
            println!("{}", serde_json::to_string_pretty(&summary)?);
            Ok(())
        }
    }
}

fn info(image_path: &std::path::Path, path: Option<&str>) -> Result<()> {
    let file = bat_image::writer::ImageFile::open(image_path)?;
    let image = file.image();
    let Some(path) = path else {
        println!(
            "entries {}\nhead_len {}\nfile_len {}\nbodies_off {}\nbody_align {}\nmtime {}\nsections {}",
            image.len(), image.head().len(), image.file_len(), image.bodies_offset(), image.body_align(), image.mtime(), image.section_count()
        );
        for i in 0..image.section_count() {
            let s = image.section_at(i);
            println!("section id={} offset={} len={}", s.id, s.offset, s.len);
        }
        return Ok(());
    };
    let Some(index) = image.resolve(bat_image::Image::ROOT, path.trim_matches('/').as_bytes(), false) else { bail!("not found: {path}") };
    let entry = image.entry(index);
    println!("/{}", String::from_utf8_lossy(entry.path));
    println!("{:?} mode={:o} size={} facts={:#x} compiled={:?}", entry.kind, entry.mode, entry.size(), entry.facts, entry.compiled().map(|e| e.len));
    if let Some(target) = entry.target() {
        println!("-> {}", String::from_utf8_lossy(target));
    }
    for child in image.read_dir(index) {
        println!("{:?}\t{}\t{}", child.kind, child.size(), String::from_utf8_lossy(child.name));
    }
    Ok(())
}

fn order(image_path: &std::path::Path, trace: &std::path::Path, root: &str) -> Result<()> {
    use std::io::Write;
    let file = bat_image::writer::ImageFile::open(image_path)?;
    let image = file.image();
    let reads: Vec<(u64, u64)> = serde_json::from_slice(&std::fs::read(trace)?)?;
    // Every extent of the image: (start, end, entry, is module record).
    let mut extents: Vec<(u64, u64, u32, bool)> = Vec::new();
    for index in 0..image.len() {
        let entry = image.entry(index);
        if let Some(body) = entry.body() {
            extents.push((body.offset, body.offset + body.len as u64, index, false));
        }
        if let Some(record) = entry.module_record() {
            extents.push((record.offset, record.offset + record.len as u64, index, true));
        }
    }
    extents.sort_unstable();
    let mut seen: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
    let mut lines: Vec<(u32, bool, bool)> = Vec::new();
    let (mut bytes, mut unknown) = (0u64, 0u64);
    for (offset, _) in reads {
        let at = extents.partition_point(|e| e.0 <= offset);
        let Some(&(_, end, index, record)) = at.checked_sub(1).and_then(|i| extents.get(i)) else { unknown += 1; continue };
        if offset >= end {
            unknown += 1; // the head, or padding
            continue;
        }
        let slot = *seen.entry(index).or_insert_with(|| {
            lines.push((index, false, false));
            lines.len() - 1
        });
        let line = &mut lines[slot];
        let had = if record { line.2 } else { line.1 };
        if !had {
            bytes += end - extents[at - 1].0;
        }
        if record { line.2 = true } else { line.1 = true }
    }
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    writeln!(out, "# start-up order: {} files, {bytes} bytes, from {}", lines.len(), image_path.file_name().unwrap_or_default().to_string_lossy())?;
    for (index, body, record) in &lines {
        let kinds = match (body, record) {
            (true, true) => "bc",
            (true, false) => "b",
            _ => "c",
        };
        writeln!(out, "{kinds}\t{}", pack::guest_path(root, &String::from_utf8_lossy(image.entry(*index).path)))?;
    }
    eprintln!("{} files, {bytes} bytes; {unknown} reads outside any body", lines.len());
    Ok(())
}
