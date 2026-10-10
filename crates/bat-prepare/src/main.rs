mod pack;
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
            let stats = pack::write_image(&items, pack::PackOptions { root, transform: None, sections: vec![], align_log2 }, &out)?;
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
    let Some(index) = image.lookup(path.trim_matches('/').as_bytes()) else { bail!("not found: {path}") };
    let entry = image.entry(index);
    println!("{:?} mode={:o} size={} facts={:#x} compiled={:?}", entry.kind, entry.mode, entry.size(), entry.facts, entry.compiled().map(|e| e.len));
    if let Some(target) = entry.target() {
        println!("-> {}", String::from_utf8_lossy(target));
    }
    for child in image.read_dir(index) {
        println!("{:?}\t{}\t{}", child.kind, child.size(), String::from_utf8_lossy(child.name));
    }
    Ok(())
}
