//! The binary's own argument handling, run as a process: what `main` does before any subcommand.

#[cfg(unix)]
#[test]
fn an_argument_that_is_not_utf8_exits_1_with_one_line_not_a_panic() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let out = std::process::Command::new(env!("CARGO_BIN_EXE_agent-console"))
        .arg("fleet")
        .arg(OsStr::from_bytes(b"/p/caf\xe9"))
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.starts_with("agent-console: an argument is not valid UTF-8: "),
        "{stderr}"
    );
    assert!(!stderr.contains("panicked"), "{stderr}");
    assert_eq!(stderr.lines().count(), 1, "{stderr}");
}
