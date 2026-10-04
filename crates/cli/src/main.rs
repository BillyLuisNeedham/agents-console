//! `agent-console`: the Console's one binary (ADR-0036), with `boot`, `server`, `steward` and `fleet`
//! subcommands.

mod boot;
mod fleet;
mod server_cli;
mod steward;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("boot") => std::process::exit(boot::run(args[1..].to_vec())),
        Some("steward") => std::process::exit(steward::run(args[1..].to_vec())),
        Some("fleet") => std::process::exit(fleet::run(args[1..].to_vec())),
        Some("server") => server_cli::run(args[1..].to_vec()),
        _ => {
            eprintln!("usage: agent-console boot|server|steward|fleet [args]");
            std::process::exit(1);
        }
    }
}
