//! The TypeScript the Console and the conformance suite import is generated from the Rust types and
//! checked in at protocol/ (ADR-0036). The checked-in files must be what `generate()` writes, byte
//! for byte, and the generated files must pass tsc alone under the Console's settings
//! (ui/tsconfig.json), which import them. Set AC_KEEP_TS_CHECK=1 to keep the tsc directory.

use std::path::{Path, PathBuf};
use std::process::Command;

use ac_protocol::typescript::generate;

fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the repository root")
}

/// The generated files alone, under the Console's settings (ui/tsconfig.json).
const UI_CONFIG: &str = r#"{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noFallthroughCasesInSwitch": true,
    "types": []
  },
  "files": ["wire.ts", "protocol.ts"]
}
"#;

#[test]
fn the_checked_in_typescript_is_what_the_rust_types_generate() {
    let root = repository();
    for file in generate() {
        let path = root.join("protocol").join(file.name);
        let checked_in = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
        assert!(
            checked_in == file.text,
            "{} is not what the Rust types generate: run \
             `cargo run -p ac-protocol --bin gen-typescript -- protocol` from the repository root",
            path.display()
        );
    }
}

#[test]
fn the_generated_typescript_passes_tsc_under_the_consoles_settings() {
    let root = repository();
    let tsc = root.join("node_modules/.bin/tsc");
    assert!(
        tsc.exists(),
        "{} is missing: run bun install at the repository root",
        tsc.display()
    );

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = root
        .join("target/ts-check")
        .join(format!("{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for file in generate() {
        std::fs::write(dir.join(file.name), &file.text).unwrap();
    }
    std::fs::write(dir.join("tsconfig.json"), UI_CONFIG).unwrap();

    let output = Command::new(&tsc)
        .arg("--noEmit")
        .arg("-p")
        .arg(dir.join("tsconfig.json"))
        .current_dir(&root)
        .output()
        .unwrap_or_else(|error| panic!("cannot run tsc: {error}"));
    assert!(
        output.status.success(),
        "tsc over the generated files under the Console's settings failed:\n{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    if std::env::var_os("AC_KEEP_TS_CHECK").is_none() {
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
