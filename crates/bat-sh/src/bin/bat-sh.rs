//! The shell on the machine's own filesystem, for comparing it with `sh`:
//!   bat-sh -c 'echo hi | wc -c'
fn main() {
    use bat_sh::interp::Io;
    let argv: Vec<String> = std::iter::once("sh".to_string()).chain(std::env::args().skip(1)).collect();
    let env: Vec<(String, String)> = std::env::vars().collect();
    let cwd = std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| "/".into());
    let st = bat_sh::main(argv, env, cwd, [Io::host(0, false), Io::host(1, false), Io::host(2, false)]);
    std::process::exit(st);
}
