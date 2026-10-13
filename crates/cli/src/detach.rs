//! Starting a process that outlives the one that starts it, as Bun's `detached: true`.

use std::os::unix::process::CommandExt;
use std::process::Command;

/// Give the command its own session, so a signal to this process group never reaches it.
pub fn detach(command: &mut Command) {
    // SAFETY: setsid is async-signal-safe and touches nothing in the parent.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
}

/// Start the command in its own session and let it go: a thread of its own waits on it, so it never
/// lingers as a zombie while this process lives, and once this process exits, init reaps it.
pub fn spawn_detached(command: &mut Command) -> std::io::Result<()> {
    detach(command);
    let mut child = command.spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}
