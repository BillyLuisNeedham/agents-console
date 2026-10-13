//! Writes the generated TypeScript (wire.ts and protocol.ts) into the directory it is given:
//! `cargo run -p ac-protocol --bin gen-typescript -- <dir>`.

use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let (Some(dir), None) = (args.next(), args.next()) else {
        eprintln!("usage: gen-typescript <dir>");
        return ExitCode::from(2);
    };
    let dir = PathBuf::from(dir);
    if let Err(error) = std::fs::create_dir_all(&dir) {
        eprintln!("gen-typescript: cannot create {}: {error}", dir.display());
        return ExitCode::FAILURE;
    }
    for file in ac_protocol::typescript::generate() {
        let path = dir.join(file.name);
        if let Err(error) = std::fs::write(&path, file.text) {
            eprintln!("gen-typescript: cannot write {}: {error}", path.display());
            return ExitCode::FAILURE;
        }
        println!("{}", path.display());
    }
    ExitCode::SUCCESS
}
