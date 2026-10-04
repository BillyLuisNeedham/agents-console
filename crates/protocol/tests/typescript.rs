//! The check ADR-0036 asks for: the TypeScript generated from the Rust types declares exactly what
//! engine/wire.ts and engine/protocol.ts declare. The generated files go to a directory inside the
//! repository beside an assertion file that holds every exported type of the two to the same type
//! (each assignable to the other, and identical), and the repository's own tsc checks it; a second
//! tsc run checks the generated files alone under the Console's stricter settings, and a script holds
//! every constant to the same value. Set AC_KEEP_TS_CHECK=1 to keep the directory.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use ac_protocol::typescript::{ExportKind, GeneratedFile, generate};

fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the repository root")
}

/// The names a hand-written file exports: its declarations and its `export type { ... } from` lists.
fn hand_written_exports(text: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let mut in_list = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if in_list || trimmed.starts_with("export type {") {
            let inner = trimmed.trim_start_matches("export type {");
            let (inner, closed) = match inner.find('}') {
                Some(end) => (&inner[..end], true),
                None => (inner, false),
            };
            names.extend(
                inner
                    .split(',')
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(String::from),
            );
            in_list = !closed;
            continue;
        }
        for prefix in ["export interface ", "export type ", "export const "] {
            if let Some(rest) = trimmed.strip_prefix(prefix) {
                let name: String = rest
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                    .collect();
                names.insert(name);
            }
        }
    }
    names
}

fn exported_names(file: &GeneratedFile) -> BTreeSet<String> {
    file.exports
        .iter()
        .map(|export| export.name.clone())
        .collect()
}

/// The assertion file: one line per exported name, generated (G) against hand-written (H).
fn assertions(files: &[GeneratedFile], up: &str) -> String {
    let mut text = format!(
        "import type * as GW from \"./wire.ts\";
import type * as HW from \"{up}engine/wire.ts\";
import type * as GP from \"./protocol.ts\";
import type * as HP from \"{up}engine/protocol.ts\";
import * as gp from \"./protocol.ts\";
import * as hp from \"{up}engine/protocol.ts\";

// Identical types: the stricter check, which also tells an optional field from a required one.
type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
// Each assignable to the other.
type Mutual<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;
type Same<X, Y> = Mutual<X, Y> extends true ? Equals<X, Y> : false;
type Check<T extends true> = T;
interface Probe {{
  id: string;
  probe: true;
}}
type EveryKind = {{ [K in HP.RequestKind]: true }};

"
    );
    for (file, generated, hand) in [(&files[0], "GW", "HW"), (&files[1], "GP", "HP")] {
        for export in &file.exports {
            let name = &export.name;
            let line = match (export.kind, name.as_str()) {
                (ExportKind::Const, _) => {
                    format!("Check<Same<typeof gp.{name}, typeof hp.{name}>>")
                }
                (ExportKind::Generic, "EntityDelta") => {
                    format!("Check<Same<{generated}.{name}<Probe>, {hand}.{name}<Probe>>>")
                }
                (ExportKind::Generic, _) => format!(
                    "Check<Equals<{{ [K in HP.RequestKind]: Same<{generated}.{name}<K>, {hand}.{name}<K>> }}, EveryKind>>"
                ),
                (ExportKind::Type, _) => format!("Check<Same<{generated}.{name}, {hand}.{name}>>"),
            };
            text.push_str(&format!("export type {generated}_{name} = {line};\n"));
        }
    }
    text
}

const VALUES: &str = "import * as gp from \"./protocol.ts\";
import * as hp from \"UP/engine/protocol.ts\";

const plain = (value: unknown) => (value instanceof Set ? [...value] : value);
const names = [...new Set([...Object.keys(gp), ...Object.keys(hp)])].sort();
const differ = names.filter(
  (name) =>
    JSON.stringify(plain((gp as Record<string, unknown>)[name])) !==
    JSON.stringify(plain((hp as Record<string, unknown>)[name])),
);
if (differ.length > 0) {
  console.error(`constants differ from engine/protocol.ts: ${differ.join(\", \")}`);
  process.exit(1);
}
console.log(`constants agree: ${names.join(\", \")}`);
";

const CHECK_CONFIG: &str = r#"{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "types": ["bun"]
  },
  "files": ["check.ts"]
}
"#;

/// The generated files alone, under the Console's settings (ui/tsconfig.json), which import them.
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

fn run(command: &mut Command, what: &str) {
    let output = command
        .output()
        .unwrap_or_else(|error| panic!("{what}: cannot run: {error}"));
    assert!(
        output.status.success(),
        "{what} failed:\n{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

/// A runtime for the values script: Bun, the repository's development tool, else Node.
fn script_runtime() -> PathBuf {
    let on_path = |name: &str| {
        std::env::var_os("PATH").and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|dir| dir.join(name))
                .find(|path| path.is_file())
        })
    };
    let home_bun = std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".bun/bin/bun"));
    on_path("bun")
        .or(home_bun.filter(|path| path.is_file()))
        .or_else(|| on_path("node"))
        .expect("the values check needs bun (on PATH or at ~/.bun/bin/bun) or node")
}

#[test]
fn the_generated_typescript_matches_wire_ts_and_protocol_ts() {
    let root = repository();
    let tsc = root.join("node_modules/.bin/tsc");
    assert!(
        tsc.exists(),
        "{} is missing: run bun install at the repository root",
        tsc.display()
    );

    let files = generate();
    for (file, hand_written) in files.iter().zip(["engine/wire.ts", "engine/protocol.ts"]) {
        let text = std::fs::read_to_string(root.join(hand_written)).expect("the hand-written file");
        assert_eq!(
            exported_names(file),
            hand_written_exports(&text),
            "{} must export exactly what {hand_written} exports",
            file.name
        );
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = root
        .join("target/ts-check")
        .join(format!("{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let up = "../../../";
    for file in &files {
        std::fs::write(dir.join(file.name), &file.text).unwrap();
    }
    std::fs::write(dir.join("check.ts"), assertions(&files, up)).unwrap();
    std::fs::write(dir.join("tsconfig.json"), CHECK_CONFIG).unwrap();
    std::fs::write(dir.join("values.ts"), VALUES.replace("UP/", up)).unwrap();
    let ui = dir.join("ui");
    std::fs::create_dir_all(&ui).unwrap();
    for file in &files {
        std::fs::write(ui.join(file.name), &file.text).unwrap();
    }
    std::fs::write(ui.join("tsconfig.json"), UI_CONFIG).unwrap();

    run(
        Command::new(&tsc)
            .arg("--noEmit")
            .arg("-p")
            .arg(dir.join("tsconfig.json"))
            .current_dir(&root),
        "tsc over the generated and hand-written types",
    );
    run(
        Command::new(&tsc)
            .arg("--noEmit")
            .arg("-p")
            .arg(ui.join("tsconfig.json"))
            .current_dir(&root),
        "tsc over the generated files under the Console's settings",
    );
    run(
        Command::new(script_runtime())
            .arg(dir.join("values.ts"))
            .current_dir(&root),
        "the constants check",
    );

    if std::env::var_os("AC_KEEP_TS_CHECK").is_none() {
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

#[test]
fn reads_the_hand_written_export_lists() {
    let names = hand_written_exports(
        "export type { A, B } from \"./a.ts\";\nexport type {\n  C,\n  D,\n} from \"./b.ts\";\nexport interface E {}\nexport const F = 1;\n",
    );
    assert_eq!(
        names,
        ["A", "B", "C", "D", "E", "F"]
            .into_iter()
            .map(String::from)
            .collect()
    );
}
