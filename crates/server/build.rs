//! A release build embeds the built Console (ui/dist, see src/ui.rs), so it refuses to build without one
//! rather than ship a binary that serves nothing. A debug build reads ui/dist from disk at run time and
//! needs none here.

use std::path::Path;

fn main() {
    let dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/dist");
    println!("cargo:rerun-if-changed={}", dist.display());
    println!("cargo:rerun-if-env-changed=CARGO_CFG_DEBUG_ASSERTIONS");
    // The target's cfg, not this script's own: a build script is compiled with its own profile.
    if std::env::var_os("CARGO_CFG_DEBUG_ASSERTIONS").is_some() {
        return;
    }
    let index = dist.join("index.html");
    if !index.is_file() {
        eprintln!(
            "error: a release build embeds the Console, and {} is missing.\n\
             Build the Console first: cd ui && bun install && bun run build\n\
             (bin/agent-console builds it before the engine on its own.)",
            index.display()
        );
        std::process::exit(1);
    }
}
