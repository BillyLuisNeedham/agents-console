//! Pane-session primitives (ADR-0014, ADR-0015, ADR-0016; pane-session.ts): the parts of a
//! terminal-backed spawn that talk to one herdr pane and know nothing about tickets, attempts or
//! outcomes: sending a wrapper command, waiting for a TUI's ready frame (answering claude's workspace
//! trust dialog on the way), and typing text with echo verification. Ticket attempts and Conversations
//! both drive a herdr pane through exactly this surface, parameterised over plain strings.

use std::time::Duration;

use tokio::time::Instant;

use ac_core::harness::SpawnContext;
use ac_core::js;
use ac_core::turn_state::VIEWPORT_WRAP_CHROME;
use ac_io::herdr::{Herdr, HerdrError, PaneEnd, PaneInput, PaneReadSource};

/// The launch half's cadences (issue #102): how the engine waits for a fresh pane's shell before
/// sending the wrapper, how long it gives `script` to prove the wrapper ran, and the workspace trust
/// dialog's pacing (issue #127). Every field overridable so a test can drive a botched launch in
/// milliseconds (`LaunchCadence { settle_poll_ms: 10, ..LaunchCadence::default() }`); the engine uses
/// the defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaunchCadence {
    /// Between shell-settle reads.
    pub settle_poll_ms: u64,
    /// Identical non-empty reads before the shell counts as settled.
    pub settle_confirmations: u32,
    /// After this, the wrapper is sent whether or not the shell settled.
    pub settle_timeout_ms: u64,
    /// How long the Stream file has to appear before the launch is botched.
    pub landed_timeout_ms: u64,
    /// Between Stream-file probes.
    pub landed_poll_ms: u64,
    /// How long the dialog is given to render its controls before the first key.
    pub dialog_settle_ms: u64,
    /// The gap between moving the highlight and confirming.
    pub dialog_key_gap_ms: u64,
    /// How long the TUI is given to leave the dialog after the confirm.
    pub dialog_confirm_ms: u64,
    /// Between readiness reads ([`READINESS_POLL_MS`]). The TypeScript fixes it; it is here so a test
    /// can run the wait in milliseconds against a real socket.
    pub readiness_poll_ms: u64,
    /// The readiness bound ([`READINESS_TIMEOUT_MS`]), fixed in the TypeScript, a test seam here too.
    pub readiness_timeout_ms: u64,
}

/// `DEFAULT_LAUNCH_CADENCE`.
impl Default for LaunchCadence {
    fn default() -> Self {
        LaunchCadence {
            settle_poll_ms: 200,
            settle_confirmations: 3,
            settle_timeout_ms: 10_000,
            landed_timeout_ms: 10_000,
            landed_poll_ms: 50,
            dialog_settle_ms: 1_500,
            dialog_key_gap_ms: 800,
            dialog_confirm_ms: 2_000,
            readiness_poll_ms: READINESS_POLL_MS,
            readiness_timeout_ms: READINESS_TIMEOUT_MS,
        }
    }
}

/// The pane-read line count for readiness and echo polling: a freshly spawned pane renders mostly blank
/// rows above its prompt, so a small read returns empty; 200 lines covers the TUI's input area and the
/// recent transcript whatever the pane's height. These launch-time reads keep herdr's `recent` source
/// (issue #122): the tab is one the engine opened and nobody is sitting in yet.
pub const INTERACTIVE_PANE_READ_LINES: u32 = 200;
const LAUNCH_READ: PaneReadSource = PaneReadSource::Recent {
    lines: INTERACTIVE_PANE_READ_LINES,
};
// Readiness requires the ready pattern on this many consecutive reads, this far apart: a single match
// can be a boot flicker, and empty reads are not ready.
const READINESS_CONFIRMATIONS: u32 = 3;
/// How far apart the readiness reads are.
pub const READINESS_POLL_MS: u64 = 500;

/// A TUI that cannot reach its ready frame within this bound is botched. An enlist (issue #101) gives a
/// working pane the same bound to reach waiting so the teaching Turn can be typed.
pub const READINESS_TIMEOUT_MS: u64 = 60_000;

/// The refusal both enlist arms answer with when a working pane never reached waiting in time.
pub fn still_working_reason(wait_ms: u64) -> String {
    let bound = if wait_ms >= 1000 {
        format!("{} s", (wait_ms as f64 / 1000.0).round())
    } else {
        format!("{wait_ms} ms")
    };
    format!(
        "the pane was still working after {bound}, so the teaching Turn could not be typed; enlist it once its agent is waiting on you"
    )
}

/// A screen claude puts up before its prompt that holds the Launch until it is answered (issue #127),
/// known by a line of its own body, never a button label. `accept` is the option the engine may
/// choose, or `None` for a dialog only the operator may answer. Read from Claude Code 2.1.276; when a
/// build drifts, this table is the one place to re-read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockingDialog {
    pub name: &'static str,
    pub heading: &'static str,
    pub accept: Option<&'static str>,
}

/// claude's Blocking dialogs.
pub const CLAUDE_BLOCKING_DIALOGS: [BlockingDialog; 3] = [
    BlockingDialog {
        name: "workspace trust dialog",
        heading: "Quick safety check",
        accept: Some("Yes, I trust this folder"),
    },
    BlockingDialog {
        name: "bypass-permissions warning",
        heading: "WARNING: Claude Code running in Bypass Permissions mode",
        accept: None,
    },
    BlockingDialog {
        name: "managed-settings trust dialog",
        heading: "Managed settings require approval",
        accept: None,
    },
];

// How many polls a dialog may stay on screen after it was answered before the wait gives up on it.
const DIALOG_LINGER_POLLS: u32 = 4;
// The row glyph claude's select puts before the highlighted option.
const HIGHLIGHT_GLYPH: &str = "❯";
// How many times a typed paste is retried (with a clear in between), and how long echo verification
// may wait per attempt.
const PROMPT_TYPED_ATTEMPTS: usize = 3;
const PROMPT_ECHO_POLL_MS: u64 = 250;
const PROMPT_ECHO_TIMEOUT_MS: u64 = 2_000;

async fn sleep_ms(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

/// The free variables a wrapper send needs out of a spawn's context: where the session records and
/// where the wrapper's exit code lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WrapperContext<'a> {
    pub log_path: &'a str,
    pub stream_path: Option<&'a str>,
    pub exit_code_path: &'a str,
}

impl<'a> From<&'a SpawnContext> for WrapperContext<'a> {
    fn from(ctx: &'a SpawnContext) -> Self {
        WrapperContext {
            log_path: &ctx.log_path,
            stream_path: ctx.stream_path.as_deref(),
            exit_code_path: &ctx.exit_code_path,
        }
    }
}

// One POSIX-safe single-quote: the quoted text cannot touch the surrounding shell.
fn shell_quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "'\\''"))
}

/// The shell a darwin harness runs behind, inside script's PTY (issue #136). BSD script sizes its
/// child's PTY once and never forwards the pane's later resizes, so the relay takes the pane's own
/// terminal as its first argument, backgrounds a loop that copies that terminal's size onto the PTY it
/// sits on whenever the two differ, and execs the rest of its argv as the harness. It never starts the
/// loop when the pane's shell had no terminal to name. POSIX sh and stty only, and no single quote.
pub const RESIZE_RELAY: &str = concat!(
    r#"o=$1; shift; p=$$; if [ -c "$o" ]; then "#,
    "while kill -0 $p 2>/dev/null; do ",
    r#"s=$(stty size <"$o" 2>/dev/null); "#,
    r#"case $s in ""|"0 "*|*" 0") ;; "#,
    r#"*) [ "$s" = "$(stty size </dev/tty 2>/dev/null)" ] || "#,
    r#"stty rows "${s% *}" columns "${s#* }" </dev/tty 2>/dev/null ;; esac; "#,
    "sleep 0.5; done </dev/null >/dev/null 2>&1 & fi; ",
    r#"exec "$@""#,
);

/// The platform a wrapper is built for: the two `script`s disagree on how the command arrives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptPlatform {
    /// util-linux script: `script -eqfc '<argv>' <stream-file>`.
    Linux,
    /// BSD script, as macOS ships: `script -eqF <stream-file> sh -c <relay> sh "$(tty)" <argv words>`.
    Darwin,
}

impl ScriptPlatform {
    /// The platform this binary runs on.
    pub fn host() -> Self {
        if cfg!(target_os = "macos") {
            ScriptPlatform::Darwin
        } else {
            ScriptPlatform::Linux
        }
    }
}

/// The ADR-0016 wrapper shell a pane runs, as one line of bash: the interactive argv under `script`,
/// which allocates the PTY the TUI requires, passes the session through to the pane live, and records
/// both directions to the Stream file. `-e` makes script's own exit status the child's, so the trailing
/// exit-code write carries the harness's code; `-q` drops script's banners. There is no `exit`, so a
/// ticket's pane stays open after the attempt completes. On darwin the harness runs behind the
/// [`RESIZE_RELAY`].
pub fn interactive_wrapper(
    argv: &[String],
    ctx: WrapperContext<'_>,
    platform: ScriptPlatform,
) -> String {
    let command = argv
        .iter()
        .map(|arg| shell_quote(arg))
        .collect::<Vec<_>>()
        .join(" ");
    // Terminal-backed sessions always carry a Stream path; the log path is the defensive fallback.
    let file = shell_quote(ctx.stream_path.unwrap_or(ctx.log_path));
    let record = match platform {
        ScriptPlatform::Darwin => format!(
            "script -eqF {file} sh -c {} sh \"$(tty)\" {command}",
            shell_quote(RESIZE_RELAY)
        ),
        ScriptPlatform::Linux => format!("script -eqfc {} {file}", shell_quote(&command)),
    };
    format!("{record}; echo $? > {}", shell_quote(ctx.exit_code_path))
}

/// How the shell-settle wait ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellSettle {
    Settled,
    TimedOut,
}

/// Wait for a fresh pane's shell to settle before anything is typed into it (issue #96, issue #102):
/// text that lands while the shell is still starting is swallowed in part. Prompt-agnostic: it waits for
/// the pane to show something and for that to stop changing across consecutive reads. Empty reads never
/// count. The caller sends either way.
pub async fn wait_for_shell_settled(
    herdr: &Herdr,
    pane_id: &str,
    cadence: &LaunchCadence,
) -> ShellSettle {
    let deadline = Instant::now() + Duration::from_millis(cadence.settle_timeout_ms);
    let mut last = String::new();
    let mut stable = 0;
    while Instant::now() < deadline {
        let read = herdr
            .peek_pane(pane_id, LAUNCH_READ)
            .await
            .unwrap_or_default();
        let text = js::trim(&read);
        if !text.is_empty() && text == last {
            stable += 1;
            if stable >= cadence.settle_confirmations {
                return ShellSettle::Settled;
            }
        } else {
            stable = u32::from(!text.is_empty());
            last = text.to_owned();
        }
        sleep_ms(cadence.settle_poll_ms).await;
    }
    ShellSettle::TimedOut
}

/// Whether the wrapper actually ran: `script` creates its Stream file the instant it starts, so the
/// file's absence a moment after the send is proof the launch command never executed. The exit-code
/// file counts too: a harness that died at once still had its wrapper run.
pub async fn wait_for_wrapper_landed(
    stream_path: &str,
    exit_code_path: &str,
    cadence: &LaunchCadence,
) -> bool {
    let landed = || js::exists(stream_path) || js::exists(exit_code_path);
    let deadline = Instant::now() + Duration::from_millis(cadence.landed_timeout_ms);
    while Instant::now() < deadline {
        if landed() {
            return true;
        }
        sleep_ms(cadence.landed_poll_ms).await;
    }
    landed()
}

/// Send the session's wrapper to its pane (ADR-0014): text and Enter in one `pane.send_input` call,
/// which herdr applies in order. A stale exit-code file and Stream file are removed first. `None` once
/// the pane carries the wrapper; on failure, closes whatever half-started pane remains (best-effort) and
/// answers the error's message, so the caller can fall back or fail the launch.
pub async fn send_wrapper_to_pane(
    herdr: &Herdr,
    pane_id: &str,
    argv: &[String],
    ctx: WrapperContext<'_>,
) -> Option<String> {
    let _ = std::fs::remove_file(ctx.exit_code_path);
    if let Some(stream_path) = ctx.stream_path {
        let _ = std::fs::remove_file(stream_path);
    }
    let input =
        PaneInput::text(interactive_wrapper(argv, ctx, ScriptPlatform::host())).and_keys(["enter"]);
    match herdr.pane_send_input(pane_id, &input).await {
        Ok(()) => None,
        Err(err) => {
            close_pane_in_background(herdr, pane_id);
            Some(err.message().to_owned())
        }
    }
}

/// `void closePane(...).catch(() => {})`.
pub fn close_pane_in_background(herdr: &Herdr, pane_id: &str) {
    let herdr = herdr.clone();
    let pane_id = pane_id.to_owned();
    tokio::spawn(async move {
        let _ = herdr.close_pane(&pane_id).await;
    });
}

/// How the readiness wait ended: the ready frame confirmed, the wrapper's exit-code file appeared (the
/// harness exited first), the pane ended with no file behind it, a Blocking dialog the engine may not
/// or could not answer, or the timeout. The last two carry the pane's last frame and, when one was
/// seen, the dialog's name (issue #127).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Readiness {
    Ready,
    Exited,
    PaneEnded,
    Blocked {
        dialog: String,
        detail: String,
        frame: String,
    },
    TimedOut {
        dialog: Option<String>,
        frame: String,
    },
}

/// Wait for the harness's ready frame on the pane's rendered content: the ready pattern on three
/// consecutive reads 500 ms apart, an empty read never ready. A pane that ends before the TUI comes up
/// fails fast, and so does a wrapper that finishes before it (its exit-code file appearing). A lost
/// pane-end subscription just stops that watch and keeps polling the content.
///
/// claude's Blocking dialogs are handled inside the wait. The workspace trust dialog is answered once,
/// by name and with the highlight verified before the confirm, and the clock restarts after the answer.
/// A dialog the engine may not answer, one whose highlight would not move, or one still up four polls
/// after its answer ends the wait as blocked at once.
pub async fn wait_for_readiness(
    herdr: &Herdr,
    pane_id: &str,
    harness: &str,
    ready_pattern: &str,
    exit_code_path: &str,
    cadence: &LaunchCadence,
) -> Readiness {
    let mut deadline = Instant::now() + Duration::from_millis(cadence.readiness_timeout_ms);
    let mut stable = 0;
    let mut lost = false;
    let mut answered: Vec<&'static str> = Vec::new();
    let mut lingering = 0;
    let mut last_frame = String::new();
    // The pane-end watch runs the whole wait; dropping it at the return lets its subscription go.
    let mut pane_end = std::pin::pin!(herdr.wait_for_pane_end(pane_id, None));
    while Instant::now() < deadline {
        if js::exists(exit_code_path) {
            return Readiness::Exited;
        }
        let text = if lost {
            herdr
                .peek_pane(pane_id, LAUNCH_READ)
                .await
                .unwrap_or_default()
        } else {
            tokio::select! {
                biased;
                end = &mut pane_end => {
                    if end == PaneEnd::Lost {
                        lost = true;
                        continue;
                    }
                    return if js::exists(exit_code_path) {
                        Readiness::Exited
                    } else {
                        Readiness::PaneEnded
                    };
                }
                read = herdr.peek_pane(pane_id, LAUNCH_READ) => read.unwrap_or_default(),
            }
        };
        if !js::trim(&text).is_empty() {
            last_frame = text.clone();
        }
        let dialog = if harness == "claude" {
            blocking_dialog_on(&text)
        } else {
            None
        };
        if let Some(dialog) = dialog {
            stable = 0;
            let Some(accept) = dialog.accept else {
                return Readiness::Blocked {
                    dialog: dialog.name.to_owned(),
                    detail: format!(
                        "the {} was on screen, which only the operator may answer",
                        dialog.name
                    ),
                    frame: text,
                };
            };
            if answered.contains(&dialog.name) {
                lingering += 1;
                if lingering >= DIALOG_LINGER_POLLS {
                    return Readiness::Blocked {
                        dialog: dialog.name.to_owned(),
                        detail: format!(
                            "the {} was still on screen after it was answered",
                            dialog.name
                        ),
                        frame: text,
                    };
                }
            } else {
                answered.push(dialog.name);
                lingering = 0;
                if let Err(frame) = answer_blocking_dialog(herdr, pane_id, accept, cadence).await {
                    return Readiness::Blocked {
                        dialog: dialog.name.to_owned(),
                        detail: format!(
                            "the {} was on screen and the highlight did not move to \"{accept}\", so it was left unanswered",
                            dialog.name
                        ),
                        frame,
                    };
                }
                deadline = Instant::now() + Duration::from_millis(cadence.readiness_timeout_ms);
            }
        } else {
            stable = if text.contains(ready_pattern) {
                stable + 1
            } else {
                0
            };
        }
        if stable >= READINESS_CONFIRMATIONS {
            return Readiness::Ready;
        }
        sleep_ms(cadence.readiness_poll_ms).await;
    }
    Readiness::TimedOut {
        dialog: answered.last().map(|name| (*name).to_owned()),
        frame: last_frame,
    }
}

/// The Blocking dialog whose heading is on the pane, if any.
pub fn blocking_dialog_on(text: &str) -> Option<&'static BlockingDialog> {
    CLAUDE_BLOCKING_DIALOGS
        .iter()
        .find(|dialog| text.contains(dialog.heading))
}

// Answer a Blocking dialog by choosing the named option: settle so the dialog's controls render, move
// the highlight with down, read the pane back and require the highlighted row to name the option, then
// confirm with enter and give the TUI time to leave the dialog. Enter is never sent at a row that does
// not read `accept`. A refused answer carries the frame it read.
async fn answer_blocking_dialog(
    herdr: &Herdr,
    pane_id: &str,
    accept: &str,
    cadence: &LaunchCadence,
) -> Result<(), String> {
    sleep_ms(cadence.dialog_settle_ms).await;
    let _ = herdr
        .pane_send_input(pane_id, &PaneInput::keys(["down"]))
        .await;
    sleep_ms(cadence.dialog_key_gap_ms).await;
    let frame = herdr
        .peek_pane(pane_id, LAUNCH_READ)
        .await
        .unwrap_or_default();
    if !highlighted_row_reads(&frame, accept) {
        return Err(frame);
    }
    let _ = herdr
        .pane_send_input(pane_id, &PaneInput::keys(["enter"]))
        .await;
    sleep_ms(cadence.dialog_confirm_ms).await;
    Ok(())
}

/// Whether the row claude highlights (its `❯` row) names `option`.
pub fn highlighted_row_reads(frame: &str, option: &str) -> bool {
    frame
        .split('\n')
        .any(|line| line.contains(HIGHLIGHT_GLYPH) && line.contains(option))
}

// Whether the pane's rendered content shows any of the targets within the echo timeout. A read that
// fails is treated as not shown, so the caller's retry loop runs again.
async fn pane_shows(herdr: &Herdr, pane_id: &str, targets: &[String]) -> bool {
    let deadline = Instant::now() + Duration::from_millis(PROMPT_ECHO_TIMEOUT_MS);
    while Instant::now() < deadline {
        let text = herdr
            .peek_pane(pane_id, LAUNCH_READ)
            .await
            .unwrap_or_default();
        if targets.iter().any(|target| viewport_shows(&text, target)) {
            return true;
        }
        sleep_ms(PROMPT_ECHO_POLL_MS).await;
    }
    false
}

/// Whether one rendered viewport shows the target, tolerating the TUI's soft wrap (issue #56): a TUI
/// breaks a long line inside its input box, so a long echo target can land split across two bordered
/// rows. Dropping everything a row break can insert from both the viewport and the target reassembles
/// a wrapped line, while a target never typed still cannot appear.
pub fn viewport_shows(text: &str, target: &str) -> bool {
    if text.contains(target) {
        return true;
    }
    let wanted = VIEWPORT_WRAP_CHROME.replace_all(target, "");
    !wanted.is_empty()
        && VIEWPORT_WRAP_CHROME
            .replace_all(text, "")
            .contains(wanted.as_ref())
}

/// Type `text` into the pane and verify it landed via `echo_targets`, retrying with `clear_keys`
/// between attempts (ADR-0016's typed-paste and echo loop, for a ticket's driver prompt, a
/// Conversation's opening Turn or a Notice). Sends Enter and answers true the moment the echo
/// confirms; false once every attempt is spent. With no clear keys there is exactly one attempt: a
/// false-negative echo cannot safely retry into a TUI it might concatenate onto. Fails when a send
/// fails.
pub async fn type_verified(
    herdr: &Herdr,
    pane_id: &str,
    text: &str,
    echo_targets: &[String],
    clear_keys: &[String],
) -> Result<bool, HerdrError> {
    let attempts = if clear_keys.is_empty() {
        1
    } else {
        PROMPT_TYPED_ATTEMPTS
    };
    for attempt in 0..attempts {
        if attempt > 0 {
            herdr
                .pane_send_input(pane_id, &PaneInput::keys(clear_keys.iter().cloned()))
                .await?;
        }
        herdr
            .pane_send_input(pane_id, &PaneInput::text(text))
            .await?;
        if pane_shows(herdr, pane_id, echo_targets).await {
            herdr
                .pane_send_input(pane_id, &PaneInput::keys(["enter"]))
                .await?;
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    //! The rows C12 left to Rust unit tests: readiness needs three consecutive ready reads 500 ms
    //! apart and never counts an empty one, a dialog still up four polls after its answer ends the
    //! wait, the wrapper for each platform byte for byte, and the darwin resize relay run under sh
    //! (engine.test.ts:6625) and on real PTYs (engine.test.ts:6651). Readiness and typing run against
    //! the fake herdr in real time: paused time jumps to the RPC watchdog's deadline while a socket
    //! read is in flight, which would spend every deadline here at the first read.

    use super::*;
    use std::sync::{Arc, Mutex};

    use ac_io::herdr::fake::{FakeHerdr, Options, Recorded, Reply};
    use serde_json::{Value, json};

    /// A pane whose rendered frames the test scripts: each read answers the next frame (the last one
    /// repeating), and a key can bring up a frame of its own.
    #[derive(Default)]
    struct Screen {
        frames: Vec<String>,
        reads: usize,
        on_key: Vec<(String, String)>,
        reads_at: Vec<Instant>,
    }

    struct Pane {
        fake: FakeHerdr,
        screen: Arc<Mutex<Screen>>,
    }

    async fn pane(frames: &[&str]) -> Pane {
        let screen = Arc::new(Mutex::new(Screen {
            frames: frames.iter().map(|f| (*f).to_owned()).collect(),
            ..Screen::default()
        }));
        let scripted = Arc::clone(&screen);
        let fake = FakeHerdr::start(Options {
            foreign_panes: vec![json!({ "pane_id": "p1", "tab_id": "t1" })],
            script: Some(Arc::new(move |method: &str, params: &Value| {
                let mut screen = scripted.lock().unwrap();
                match method {
                    "pane.read" => {
                        screen.reads_at.push(Instant::now());
                        let at = screen.reads.min(screen.frames.len().saturating_sub(1));
                        screen.reads += 1;
                        let text = screen.frames.get(at).cloned().unwrap_or_default();
                        Some(Reply::Line(
                            json!({ "id": "1", "result": { "read": { "text": text } } })
                                .to_string(),
                        ))
                    }
                    "pane.send_input" => {
                        let keys = params.get("keys").and_then(Value::as_array).cloned();
                        for key in keys.unwrap_or_default() {
                            let key = key.as_str().unwrap_or_default().to_owned();
                            if let Some((_, frame)) =
                                screen.on_key.iter().find(|(k, _)| *k == key).cloned()
                            {
                                let keep = screen.reads.min(screen.frames.len());
                                screen.frames.truncate(keep);
                                screen.frames.push(frame);
                            }
                        }
                        None
                    }
                    _ => None,
                }
            })),
            ..Options::default()
        })
        .await;
        Pane { fake, screen }
    }

    fn fast() -> LaunchCadence {
        LaunchCadence {
            settle_poll_ms: 10,
            settle_confirmations: 2,
            settle_timeout_ms: 1_000,
            landed_timeout_ms: 300,
            landed_poll_ms: 20,
            dialog_settle_ms: 20,
            dialog_key_gap_ms: 20,
            dialog_confirm_ms: 20,
            readiness_poll_ms: 20,
            readiness_timeout_ms: 1_000,
        }
    }

    fn scratch() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let exit_code = format!("{}/01.exitcode", js::path_text(dir.path()));
        (dir, exit_code)
    }

    fn calls(fake: &FakeHerdr, method: &str) -> Vec<Value> {
        fake.requests()
            .into_iter()
            .filter(|Recorded { method: m, .. }| m == method)
            .map(|recorded| recorded.params)
            .collect()
    }

    #[tokio::test]
    async fn readiness_needs_three_consecutive_ready_reads_500_ms_apart() {
        let (_dir, exit_code) = scratch();
        // An empty read, a flicker of the ready frame, a blank, then the frame for good.
        let p = pane(&["", "Claude Code v2", "boot", "Claude Code v2"]).await;
        // The engine's own readiness pacing.
        let cadence = LaunchCadence::default();
        assert_eq!(cadence.readiness_poll_ms, 500);
        assert_eq!(cadence.readiness_timeout_ms, 60_000);
        let readiness = wait_for_readiness(
            &p.fake.herdr(),
            "p1",
            "claude",
            "Claude Code v",
            &exit_code,
            &cadence,
        )
        .await;
        assert_eq!(readiness, Readiness::Ready);
        let screen = p.screen.lock().unwrap();
        // Two reads before the frame settled, then three matching ones.
        assert_eq!(screen.reads, 6);
        for pair in screen.reads_at.windows(2) {
            assert!(pair[1] - pair[0] >= Duration::from_millis(READINESS_POLL_MS));
        }
    }

    #[tokio::test]
    async fn readiness_never_counts_an_empty_pane() {
        let (_dir, exit_code) = scratch();
        let p = pane(&["", "   "]).await;
        let readiness = wait_for_readiness(
            &p.fake.herdr(),
            "p1",
            "opencode",
            "Ask anything",
            &exit_code,
            &fast(),
        )
        .await;
        assert_eq!(
            readiness,
            Readiness::TimedOut {
                dialog: None,
                frame: String::new()
            }
        );
    }

    #[tokio::test]
    async fn readiness_fails_fast_on_the_exit_code_file() {
        let (_dir, exit_code) = scratch();
        std::fs::write(&exit_code, "1").unwrap();
        let p = pane(&["$ "]).await;
        let readiness = wait_for_readiness(
            &p.fake.herdr(),
            "p1",
            "claude",
            "Claude Code v",
            &exit_code,
            &fast(),
        )
        .await;
        assert_eq!(readiness, Readiness::Exited);
    }

    const TRUST: &str = "Quick safety check\n❯ 1. No, exit\n  2. Yes, I trust this folder";
    const TRUST_MOVED: &str = "Quick safety check\n  1. No, exit\n❯ 2. Yes, I trust this folder";

    #[tokio::test]
    async fn answers_the_trust_dialog_by_name_and_restarts_the_clock() {
        let (_dir, exit_code) = scratch();
        let p = pane(&[TRUST]).await;
        {
            let mut screen = p.screen.lock().unwrap();
            screen.on_key.push(("down".into(), TRUST_MOVED.into()));
            screen
                .on_key
                .push(("enter".into(), "Claude Code v2\n❯ ".into()));
        }
        let readiness = wait_for_readiness(
            &p.fake.herdr(),
            "p1",
            "claude",
            "Claude Code v",
            &exit_code,
            &fast(),
        )
        .await;
        assert_eq!(readiness, Readiness::Ready);
        let keys: Vec<Value> = calls(&p.fake, "pane.send_input")
            .into_iter()
            .map(|params| params["keys"].clone())
            .collect();
        assert_eq!(keys, [json!(["down"]), json!(["enter"])]);
    }

    #[tokio::test]
    async fn a_dialog_still_up_four_polls_after_its_answer_ends_the_wait() {
        let (_dir, exit_code) = scratch();
        let p = pane(&[TRUST]).await;
        p.screen
            .lock()
            .unwrap()
            .on_key
            .push(("down".into(), TRUST_MOVED.into()));
        let readiness = wait_for_readiness(
            &p.fake.herdr(),
            "p1",
            "claude",
            "Claude Code v",
            &exit_code,
            &fast(),
        )
        .await;
        assert_eq!(
            readiness,
            Readiness::Blocked {
                dialog: "workspace trust dialog".into(),
                detail: "the workspace trust dialog was still on screen after it was answered"
                    .into(),
                frame: TRUST_MOVED.into(),
            }
        );
        // The answer's read, the first sighting, then four lingering polls.
        assert_eq!(p.screen.lock().unwrap().reads, 6);
    }

    #[tokio::test]
    async fn leaves_the_dialog_unanswered_when_the_highlight_does_not_move() {
        let (_dir, exit_code) = scratch();
        let p = pane(&[TRUST]).await;
        let readiness = wait_for_readiness(
            &p.fake.herdr(),
            "p1",
            "claude",
            "Claude Code v",
            &exit_code,
            &fast(),
        )
        .await;
        assert_eq!(
            readiness,
            Readiness::Blocked {
                dialog: "workspace trust dialog".into(),
                detail: "the workspace trust dialog was on screen and the highlight did not move to \"Yes, I trust this folder\", so it was left unanswered".into(),
                frame: TRUST.into(),
            }
        );
        let keys: Vec<Value> = calls(&p.fake, "pane.send_input")
            .into_iter()
            .map(|params| params["keys"].clone())
            .collect();
        assert_eq!(keys, [json!(["down"])]);
    }

    #[tokio::test]
    async fn never_answers_the_bypass_warning_and_ignores_dialogs_on_other_harnesses() {
        let (_dir, exit_code) = scratch();
        let warning = "WARNING: Claude Code running in Bypass Permissions mode\n❯ 1. No, exit";
        let p = pane(&[warning]).await;
        let readiness = wait_for_readiness(
            &p.fake.herdr(),
            "p1",
            "claude",
            "Claude Code v",
            &exit_code,
            &fast(),
        )
        .await;
        assert_eq!(
            readiness,
            Readiness::Blocked {
                dialog: "bypass-permissions warning".into(),
                detail: "the bypass-permissions warning was on screen, which only the operator may answer".into(),
                frame: warning.into(),
            }
        );
        assert!(calls(&p.fake, "pane.send_input").is_empty());

        let p = pane(&[TRUST]).await;
        let readiness = wait_for_readiness(
            &p.fake.herdr(),
            "p1",
            "opencode",
            "Ask anything",
            &exit_code,
            &fast(),
        )
        .await;
        assert_eq!(
            readiness,
            Readiness::TimedOut {
                dialog: None,
                frame: TRUST.into()
            }
        );
        assert!(calls(&p.fake, "pane.send_input").is_empty());
    }

    #[tokio::test]
    async fn readiness_ends_on_the_pane_end() {
        let (_dir, exit_code) = scratch();
        let p = pane(&["booting"]).await;
        let herdr = p.fake.herdr();
        let waiting = tokio::spawn({
            let exit_code = exit_code.clone();
            async move {
                wait_for_readiness(&herdr, "p1", "claude", "Claude Code v", &exit_code, &fast())
                    .await
            }
        });
        for _ in 0..1000 {
            if p.fake.subscribers() == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        p.fake.push_event("pane_exited", json!({ "pane_id": "p1" }));
        assert_eq!(waiting.await.unwrap(), Readiness::PaneEnded);
    }

    #[tokio::test]
    async fn the_shell_settles_on_identical_non_empty_reads() {
        let p = pane(&["", "$", "$ ", "$ "]).await;
        let settled = wait_for_shell_settled(&p.fake.herdr(), "p1", &fast()).await;
        assert_eq!(settled, ShellSettle::Settled);
        // "$" and "$ " trim the same, so the second read already confirms the first.
        assert_eq!(p.screen.lock().unwrap().reads, 3);
        let p = pane(&[""]).await;
        assert_eq!(
            wait_for_shell_settled(&p.fake.herdr(), "p1", &fast()).await,
            ShellSettle::TimedOut
        );
    }

    #[tokio::test]
    async fn type_verified_retries_with_clear_keys_and_presses_enter_on_the_echo() {
        let p = pane(&["empty"]).await;
        let landed = type_verified(
            &p.fake.herdr(),
            "p1",
            "hello",
            &["hello".to_owned()],
            &["ctrl+c".to_owned()],
        )
        .await
        .unwrap();
        assert!(!landed);
        let sent = calls(&p.fake, "pane.send_input");
        assert_eq!(
            sent,
            [
                json!({ "pane_id": "p1", "text": "hello" }),
                json!({ "pane_id": "p1", "keys": ["ctrl+c"] }),
                json!({ "pane_id": "p1", "text": "hello" }),
                json!({ "pane_id": "p1", "keys": ["ctrl+c"] }),
                json!({ "pane_id": "p1", "text": "hello" }),
            ]
        );
        // With no clear keys, one attempt only; an echo presses Enter.
        let p = pane(&["> hello"]).await;
        let landed = type_verified(&p.fake.herdr(), "p1", "hello", &["hello".to_owned()], &[])
            .await
            .unwrap();
        assert!(landed);
        assert_eq!(
            calls(&p.fake, "pane.send_input"),
            [
                json!({ "pane_id": "p1", "text": "hello" }),
                json!({ "pane_id": "p1", "keys": ["enter"] }),
            ]
        );
    }

    #[test]
    fn the_viewport_shows_a_target_wrapped_across_bordered_rows() {
        let target = "/tmp/pool/issues/01-a-long-ticket-name.md";
        let wrapped = "│ /tmp/pool/issues/01-a-long- │\n│ ticket-name.md              │";
        assert!(viewport_shows(wrapped, target));
        assert!(!viewport_shows(wrapped, "/tmp/pool/issues/02-other.md"));
        assert!(viewport_shows("anything", ""));
        assert!(!viewport_shows("anything", "  ─ "));
    }

    #[test]
    fn the_highlighted_row_must_name_the_option() {
        assert!(highlighted_row_reads(
            TRUST_MOVED,
            "Yes, I trust this folder"
        ));
        assert!(!highlighted_row_reads(TRUST, "Yes, I trust this folder"));
        assert_eq!(
            blocking_dialog_on("x Managed settings require approval y").map(|d| d.name),
            Some("managed-settings trust dialog")
        );
        assert_eq!(blocking_dialog_on("Claude Code v2"), None);
    }

    fn argv() -> Vec<String> {
        ["claude", "--model", "it's a model", "two words"]
            .iter()
            .map(|word| (*word).to_owned())
            .collect()
    }

    fn wrapper_ctx() -> WrapperContext<'static> {
        WrapperContext {
            log_path: "/p/runs/01.log",
            stream_path: Some("/p/runs/01.stream.jsonl"),
            exit_code_path: "/p/runs/01.exitcode",
        }
    }

    #[test]
    fn the_linux_wrapper_is_util_linux_scripts_c_string_form() {
        assert_eq!(
            interactive_wrapper(&argv(), wrapper_ctx(), ScriptPlatform::Linux),
            r#"script -eqfc ''\''claude'\'' '\''--model'\'' '\''it'\''\'\'''\''s a model'\'' '\''two words'\''' '/p/runs/01.stream.jsonl'; echo $? > '/p/runs/01.exitcode'"#
        );
    }

    #[test]
    fn the_darwin_wrapper_runs_the_harness_behind_the_resize_relay() {
        let relay = format!("'{RESIZE_RELAY}'");
        assert!(!RESIZE_RELAY.contains('\''));
        assert_eq!(
            interactive_wrapper(&argv(), wrapper_ctx(), ScriptPlatform::Darwin),
            format!(
                r#"script -eqF '/p/runs/01.stream.jsonl' sh -c {relay} sh "$(tty)" 'claude' '--model' 'it'\''s a model' 'two words'; echo $? > '/p/runs/01.exitcode'"#
            )
        );
        assert_eq!(
            RESIZE_RELAY,
            "o=$1; shift; p=$$; if [ -c \"$o\" ]; then while kill -0 $p 2>/dev/null; do s=$(stty size <\"$o\" 2>/dev/null); case $s in \"\"|\"0 \"*|*\" 0\") ;; *) [ \"$s\" = \"$(stty size </dev/tty 2>/dev/null)\" ] || stty rows \"${s% *}\" columns \"${s#* }\" </dev/tty 2>/dev/null ;; esac; sleep 0.5; done </dev/null >/dev/null 2>&1 & fi; exec \"$@\""
        );
    }

    #[test]
    fn the_wrapper_falls_back_to_the_log_path_with_no_stream_file() {
        let ctx = WrapperContext {
            stream_path: None,
            ..wrapper_ctx()
        };
        assert!(
            interactive_wrapper(&argv(), ctx, ScriptPlatform::Linux).contains(" '/p/runs/01.log';")
        );
    }

    #[test]
    fn the_resize_relay_execs_the_harness_with_its_exit_code_and_no_loop_without_a_terminal() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("argv");
        let harness = format!("printf '%s\\n' \"$@\" > '{}'; exit 7", out.display());
        let status = std::process::Command::new("sh")
            .args([
                "-c",
                RESIZE_RELAY,
                "sh",
                "/not/a/tty",
                "sh",
                "-c",
                &harness,
                "harness",
                "a word",
                "it's",
            ])
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert_eq!(status.status.code(), Some(7));
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "a word\nit's\n");
        // No loop was left behind: the relay execs straight into the harness, so nothing holds the
        // output pipe open after it.
        assert!(status.stdout.is_empty());
    }

    #[test]
    fn still_working_reason_rounds_to_seconds() {
        assert_eq!(
            still_working_reason(60_000),
            "the pane was still working after 60 s, so the teaching Turn could not be typed; enlist it once its agent is waiting on you"
        );
        assert!(still_working_reason(1_500).contains("after 2 s,"));
        assert!(still_working_reason(250).contains("after 250 ms,"));
    }

    // Real PTYs, made and resized with util-linux script and GNU `stty -F`, so this runs on Linux only
    // (engine.test.ts:6651); the relay itself is POSIX sh and stty, which BSD reads the same way.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn the_resize_relay_copies_each_pane_resize_onto_the_harness_pty_and_signals_it() {
        use std::process::Stdio;

        let dir = tempfile::tempdir().unwrap();
        let pane_path = dir.path().join("pane.tty");
        let out = dir.path().join("harness.out");
        let quiet = |command: &mut tokio::process::Command| {
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true);
        };
        let until = |what: &'static str, cond: Box<dyn Fn() -> bool>| async move {
            let deadline = std::time::Instant::now() + Duration::from_secs(8);
            while !cond() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "timed out waiting for {what}"
                );
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        };
        // The pane: a PTY that only names itself and waits.
        let mut pane = tokio::process::Command::new("script");
        pane.args([
            "-qfc",
            &format!("tty > '{}'; sleep 30", pane_path.display()),
            "/dev/null",
        ]);
        quiet(&mut pane);
        let _pane = pane.spawn().unwrap();
        let named = pane_path.clone();
        until(
            "the pane's terminal",
            Box::new(move || {
                std::fs::read_to_string(&named).is_ok_and(|text| !text.trim().is_empty())
            }),
        )
        .await;
        let pane_tty = std::fs::read_to_string(&pane_path)
            .unwrap()
            .trim()
            .to_owned();
        let resize_pane = |rows: u32, cols: u32| {
            let status = std::process::Command::new("stty")
                .args([
                    "-F",
                    &pane_tty,
                    "rows",
                    &rows.to_string(),
                    "columns",
                    &cols.to_string(),
                ])
                .status()
                .unwrap();
            assert!(status.success());
        };
        resize_pane(30, 100);
        // The harness's PTY: script with no terminal of its own forwards no resize, as BSD script
        // never does. The harness reports each SIGWINCH and its size.
        let harness = "trap 'echo WINCH' WINCH; while :; do stty size; sleep 0.1; done";
        let inner = [
            "sh",
            "-c",
            RESIZE_RELAY,
            "sh",
            &pane_tty,
            "sh",
            "-c",
            harness,
        ]
        .iter()
        .map(|word| shell_quote(word))
        .collect::<Vec<_>>()
        .join(" ");
        let mut relayed = tokio::process::Command::new("script");
        relayed.args(["-qfc", &inner, &out.display().to_string()]);
        quiet(&mut relayed);
        let _relayed = relayed.spawn().unwrap();
        let seen = move || std::fs::read_to_string(&out).unwrap_or_default();
        let s = seen.clone();
        until("the launch size", Box::new(move || s().contains("30 100"))).await;
        resize_pane(40, 120);
        let s = seen.clone();
        until("the first resize", Box::new(move || s().contains("40 120"))).await;
        resize_pane(25, 70);
        let s = seen.clone();
        until("the second resize", Box::new(move || s().contains("25 70"))).await;
        assert!(seen().matches("WINCH").count() >= 3);
    }
}
