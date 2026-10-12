//! `agent-console`: the Console's one binary (ADR-0036), with `boot`, `server`, `steward` and `fleet`
//! subcommands.

use std::ffi::OsString;

mod boot;
mod detach;
mod fleet;
mod server_cli;
mod steward;

// The arguments after the program name, as text. `std::env::args` panics on one that is not UTF-8;
// that one is handed back instead, so main can say so and exit 1.
fn text_args(args: impl Iterator<Item = OsString>) -> Result<Vec<String>, OsString> {
    args.map(OsString::into_string).collect()
}

fn main() {
    let args = match text_args(std::env::args_os().skip(1)) {
        Ok(args) => args,
        Err(arg) => {
            eprintln!("agent-console: an argument is not valid UTF-8: {arg:?}");
            std::process::exit(1);
        }
    };
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_come_through_as_text() {
        let args = ["server", "--pool", "/p/café"].map(OsString::from);
        assert_eq!(
            text_args(args.into_iter()).unwrap(),
            ["server", "--pool", "/p/café"]
        );
        assert_eq!(text_args(std::iter::empty()).unwrap(), Vec::<String>::new());
    }

    #[cfg(unix)]
    #[test]
    fn an_argument_that_is_not_utf8_is_handed_back_not_a_panic() {
        use std::os::unix::ffi::OsStringExt;

        let bad = OsString::from_vec(b"/p/caf\xe9".to_vec());
        let args = vec![
            OsString::from("server"),
            bad.clone(),
            OsString::from("--yes"),
        ];
        assert_eq!(text_args(args.into_iter()), Err(bad));
    }
}
