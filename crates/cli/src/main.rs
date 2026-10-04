//! `agent-console`: the Console's one binary (ADR-0036), with `boot`, `server`, `steward` and `fleet`
//! subcommands.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("server") | Some("boot") | Some("steward") | Some("fleet") => {
            eprintln!("agent-console {}: not ported yet", args[0]);
            std::process::exit(1);
        }
        _ => {
            eprintln!("usage: agent-console boot|server|steward|fleet [args]");
            std::process::exit(1);
        }
    }
}
