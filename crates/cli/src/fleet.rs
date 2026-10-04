//! The fleet list command (fleet-cli.ts): answers "what's running". It reads the fleet registry and,
//! because reads prune, dead servers and deleted pools never appear. Each live pool prints as one plain
//! line, `poolDir → http://localhost:<port>`, so the output composes with xargs and friends. The
//! command is strictly read-only: it never starts, stops, or signals anything, and it never rewrites
//! the registry.

use std::io::Write;

use ac_core::fleet::{default_registry_path, list_fleet};

/// The registry `--registry` names, or the machine's own under the home directory.
pub fn registry_path(args: &[String], home: &str) -> String {
    args.iter()
        .position(|arg| arg == "--registry")
        .and_then(|at| args.get(at + 1))
        .filter(|path| !path.is_empty())
        .cloned()
        .unwrap_or_else(|| default_registry_path(home))
}

/// `agent-console fleet [--registry <file>]`: one line per live pool, or the no-live-consoles line.
pub fn run(args: Vec<String>) -> i32 {
    let registry = registry_path(&args, &crate::boot::home_dir());
    let mut out = std::io::stdout();
    for line in list_fleet(&registry) {
        let _ = writeln!(out, "{line}");
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn reads_the_registry_it_is_given_else_the_one_under_home() {
        assert_eq!(
            registry_path(&strings(&["--registry", "/r/pools.json"]), "/home/me"),
            "/r/pools.json"
        );
        assert_eq!(
            registry_path(&strings(&[]), "/home/me"),
            "/home/me/.agent-graphs/pools.json"
        );
        assert_eq!(
            registry_path(&strings(&["--registry"]), "/home/me"),
            "/home/me/.agent-graphs/pools.json"
        );
        assert_eq!(
            registry_path(&strings(&["--registry", ""]), "/home/me"),
            "/home/me/.agent-graphs/pools.json"
        );
    }
}
