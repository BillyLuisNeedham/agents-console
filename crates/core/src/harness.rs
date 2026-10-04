//! The harness table (spawn.ts): one descriptor per known harness carrying everything the two spawn
//! paths need (the batch argv a headless spawn runs, the interactive argv a terminal-backed spawn hands
//! its pane, the readiness, idle and echo patterns, the clear keys, the prompt shaping per mode, the log
//! mode and which modes take an effort), the table a pool resolves a harness name against, and every
//! string a harness gets on its command line.
//!
//! Named `harness` rather than `spawn` so it is not read as the Spawns (proposals) module.

use std::fmt;
use std::sync::Arc;

use crate::config::ConfigError;
use crate::js_compat;

/// Everything an argv builder reads about one Attempt's launch.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SpawnContext {
    pub id: String,
    /// The canonical Issue file: the absolute main-checkout path. The driver line hands it to the agent
    /// for reading the spec and for ticking acceptance criteria; it is not a status channel.
    pub issue_path: String,
    pub body: String,
    pub driver: String,
    pub harness: String,
    pub model: String,
    /// The Assignment's effort (CONTEXT.md: Effort), verbatim; absent leaves the harness on its own
    /// default. Each argv builder whose mode takes an effort passes it; the rest ignore it.
    pub effort: Option<String>,
    pub log_path: String,
    pub outcome_path: String,
    /// The attempt's exit-code file (ADR-0014), which a terminal-backed attempt's wrapper writes.
    /// Headless spawns ignore it.
    pub exit_code_path: String,
    pub cwd: String,
    /// The attempt's Stream file (ADR-0012), or `None` when the harness has no stream mode.
    pub stream_path: Option<String>,
}

impl SpawnContext {
    /// The structured fields prompt shaping reads.
    pub fn shaping(&self) -> PromptShapingContext<'_> {
        PromptShapingContext {
            driver: &self.driver,
            issue_path: &self.issue_path,
            body: &self.body,
        }
    }

    // The flag pair carrying the effort, or nothing when the Assignment names none.
    fn effort_args(&self, flag: &str) -> Vec<String> {
        match self.effort.as_deref() {
            Some(effort) if !effort.is_empty() => vec![flag.to_owned(), effort.to_owned()],
            _ => Vec::new(),
        }
    }
}

/// The structured fields prompt shaping reads: the driver and the issue reference arrive as fields,
/// never as a wall of text the shaping must parse back out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromptShapingContext<'a> {
    pub driver: &'a str,
    pub issue_path: &'a str,
    pub body: &'a str,
}

/// One harness's prompt shaping for one mode.
pub type PromptShaping = fn(PromptShapingContext<'_>) -> String;

/// An argv builder of a known harness.
pub type ArgvBuilder = fn(&SpawnContext) -> Vec<String>;

/// A command a pool (or a test) registers under a harness name, overriding a known harness or adding
/// one: it owns what runs.
pub type HarnessCommand = Arc<dyn Fn(&SpawnContext) -> Vec<String> + Send + Sync>;

/// The log modes a harness declares (ADR-0012): "stream" harnesses spawn with a structured stream and
/// their attempt log is derived from it live; "raw" harnesses pass stdout and stderr through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HarnessStreamMode {
    Stream,
    Raw,
}

/// The two spawn modes: headless batch, or the terminal-backed TUI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HarnessMode {
    Batch,
    Interactive,
}

/// The prompt shaping per mode.
#[derive(Debug, Clone, Copy)]
pub struct PromptShapings {
    pub batch: PromptShaping,
    pub interactive: PromptShaping,
}

/// Which modes' argv carry the Assignment's effort.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TakesEffort {
    pub batch: bool,
    pub interactive: bool,
}

impl TakesEffort {
    pub fn get(self, mode: HarnessMode) -> bool {
        match mode {
            HarnessMode::Batch => self.batch,
            HarnessMode::Interactive => self.interactive,
        }
    }
}

/// The per-harness spawn descriptor (pool ticket 01, ADR-0016): one record carrying everything the two
/// spawn paths need, so the interactive work lands as fields here instead of as surgery inside the
/// spawn paths.
#[derive(Debug)]
pub struct HarnessDescriptor {
    /// The harness name the descriptor is registered under.
    pub name: &'static str,
    /// The argv a headless spawn runs: batch mode, stdin closed by the engine, the prompt carried as
    /// argv (or --command), the fullest auto-approve mode.
    pub batch_argv: ArgvBuilder,
    /// The argv a terminal-backed spawn runs: the interactive TUI, the batch-only flags dropped,
    /// auto-approve preserved.
    pub interactive_argv: ArgvBuilder,
    /// The pane-rendered pattern that marks the TUI ready for typed input (the prototype's canonical
    /// fixture). The bare prompt glyph is deliberately not used: the pane's own bash prompt collides.
    pub ready_pattern: &'static str,
    /// The pane-rendered pattern that marks the TUI idle, waiting on the operator (the Conversations
    /// ADR's Turn state). Defaults to the ready pattern through `idle_pattern_for`.
    pub idle_pattern: Option<&'static str>,
    /// The pane-rendered pattern that confirms a pasted prompt landed in the input area. claude and
    /// cursor collapse a long paste to a `[Pasted text #N +N lines]` marker; opencode echoes inline and
    /// has none, so the engine falls back to the prompt's issue reference.
    pub echo_pattern: Option<&'static str>,
    /// Keys that empty the TUI input area, sent before a retry or fallback paste. Empty until a
    /// sequence is verified against the live TUI (claude's stays empty pending verification). Never
    /// sent before the first paste.
    pub clear_keys: &'static [&'static str],
    pub prompt_shaping: PromptShapings,
    pub stream_mode: HarnessStreamMode,
    pub takes_effort: TakesEffort,
}

// The prompt text each mode hands the agent. claude expands a leading "/<driver> ..." as a slash
// command in both modes; opencode's batch mode carries the bare driver name in --command (so its batch
// shape is the message alone) while its TUI takes "/<driver> ..." like claude's; cursor takes the slash
// line in both modes (prototype/tui-prompt-paste/FINDINGS.md sections 3-4).
fn slash_batch(ctx: PromptShapingContext<'_>) -> String {
    format!("/{} {}\n\n{}", ctx.driver, ctx.issue_path, ctx.body)
}

fn slash_interactive(ctx: PromptShapingContext<'_>) -> String {
    format!(
        "/{} {}\n\n{}\n{}",
        ctx.driver, ctx.issue_path, ctx.body, ctx.issue_path
    )
}

fn message_batch(ctx: PromptShapingContext<'_>) -> String {
    format!("{}\n\n{}", ctx.issue_path, ctx.body)
}

fn owned(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn claude_batch(ctx: &SpawnContext) -> Vec<String> {
    let mut argv = owned(&["claude", "-p"]);
    argv.push((CLAUDE.prompt_shaping.batch)(ctx.shaping()));
    argv.extend(owned(&["--model", &ctx.model]));
    argv.extend(ctx.effort_args("--effort"));
    // The structured stream the pump tees to the attempt's Stream file (ADR-0012); --verbose is
    // required by the real CLI for stream-json in print mode.
    argv.extend(owned(&[
        "--permission-mode",
        "auto",
        "--output-format",
        "stream-json",
        "--verbose",
    ]));
    argv
}

fn claude_interactive(ctx: &SpawnContext) -> Vec<String> {
    let mut argv = owned(&["claude", "--model", &ctx.model]);
    argv.extend(ctx.effort_args("--effort"));
    argv.extend(owned(&["--permission-mode", "auto"]));
    argv
}

fn opencode_batch(ctx: &SpawnContext) -> Vec<String> {
    let mut argv = owned(&["opencode", "run", "--command", &ctx.driver]);
    argv.push((OPENCODE.prompt_shaping.batch)(ctx.shaping()));
    argv.extend(owned(&["--model", &ctx.model]));
    // opencode calls it a variant (minimal, low, high, max, ...).
    argv.extend(ctx.effort_args("--variant"));
    argv.push("--auto".to_owned());
    argv
}

fn opencode_interactive(ctx: &SpawnContext) -> Vec<String> {
    owned(&["opencode", "--model", &ctx.model, "--auto"])
}

fn cursor_batch(ctx: &SpawnContext) -> Vec<String> {
    let mut argv = owned(&["agent", "-p"]);
    argv.push((CURSOR.prompt_shaping.batch)(ctx.shaping()));
    // No --verbose: the Cursor Agent CLI rejects it ("unknown option '--verbose'").
    argv.extend(owned(&[
        "--model",
        &ctx.model,
        "--force",
        "--trust",
        "--output-format",
        "stream-json",
    ]));
    argv
}

fn cursor_interactive(ctx: &SpawnContext) -> Vec<String> {
    owned(&["agent", "--model", &ctx.model, "--force", "--trust"])
}

/// claude: the /driver line at the top of the -p prompt expands as a slash command.
pub static CLAUDE: HarnessDescriptor = HarnessDescriptor {
    name: "claude",
    batch_argv: claude_batch,
    interactive_argv: claude_interactive,
    ready_pattern: "Claude Code v",
    // The ready-frame header stays on screen while the agent works, so it cannot double as an idle
    // signal; the input box's glyph is a "the TUI is up" guard, and idleness rests on the transcript
    // holding still (turn-state.ts).
    idle_pattern: Some("❯"),
    echo_pattern: Some("Pasted text"),
    // Unverified on this machine: the operator confirms a clear sequence before this slot is populated.
    clear_keys: &[],
    prompt_shaping: PromptShapings {
        batch: slash_batch,
        interactive: slash_interactive,
    },
    stream_mode: HarnessStreamMode::Stream,
    // `--effort <level>` in both modes (low, medium, high, xhigh, max).
    takes_effort: TakesEffort {
        batch: true,
        interactive: true,
    },
};

/// opencode: no slash command inside a run message, so the driver goes through --command and
/// everything else is the message.
pub static OPENCODE: HarnessDescriptor = HarnessDescriptor {
    name: "opencode",
    batch_argv: opencode_batch,
    interactive_argv: opencode_interactive,
    ready_pattern: "Ask anything",
    // The first-boot placeholder disappears once a session has history, so idleness falls back to the
    // footer's hint; unverified beyond the boot frame.
    idle_pattern: Some("ctrl+p commands"),
    echo_pattern: None,
    clear_keys: &["ctrl+c"],
    prompt_shaping: PromptShapings {
        batch: message_batch,
        interactive: slash_interactive,
    },
    stream_mode: HarnessStreamMode::Raw,
    // Only `opencode run` has --variant; the TUI has no such flag.
    takes_effort: TakesEffort {
        batch: true,
        interactive: false,
    },
};

/// cursor: run against the real Cursor Agent CLI (2026.09.02-c22c1a3).
pub static CURSOR: HarnessDescriptor = HarnessDescriptor {
    name: "cursor",
    batch_argv: cursor_batch,
    interactive_argv: cursor_interactive,
    ready_pattern: "Cursor Agent",
    // The ready frame's input placeholder without its arrow glyph; captured only at the boot frame.
    idle_pattern: Some("Plan, search, build anything"),
    echo_pattern: Some("Pasted text"),
    clear_keys: &["ctrl+c"],
    prompt_shaping: PromptShapings {
        batch: slash_batch,
        interactive: slash_interactive,
    },
    stream_mode: HarnessStreamMode::Stream,
    // The Cursor Agent CLI has no effort flag in either mode.
    takes_effort: TakesEffort {
        batch: false,
        interactive: false,
    },
};

/// The known harnesses' descriptors, in the TypeScript record's order.
pub fn default_harness_descriptors() -> [&'static HarnessDescriptor; 3] {
    [&CLAUDE, &OPENCODE, &CURSOR]
}

/// The descriptor a harness name has, if it is a known one.
pub fn harness_descriptor(name: &str) -> Option<&'static HarnessDescriptor> {
    default_harness_descriptors()
        .into_iter()
        .find(|descriptor| descriptor.name == name)
}

/// A harness name's entry in a pool's table: a known harness's own descriptor (the engine's batch
/// command), or a command the pool registered.
#[derive(Clone)]
pub enum Harness {
    Known(&'static HarnessDescriptor),
    Custom(HarnessCommand),
}

impl fmt::Debug for Harness {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Harness::Known(descriptor) => write!(f, "Known({})", descriptor.name),
            Harness::Custom(_) => f.write_str("Custom(..)"),
        }
    }
}

impl Harness {
    /// The command a headless spawn runs: the batch argv, or the registered command.
    pub fn batch_argv(&self, ctx: &SpawnContext) -> Vec<String> {
        match self {
            Harness::Known(descriptor) => (descriptor.batch_argv)(ctx),
            Harness::Custom(command) => command(ctx),
        }
    }

    // Whether this entry is `name`'s own descriptor: the engine's batch command, not replaced.
    fn is_own_descriptor_of(&self, name: &str) -> Option<&'static HarnessDescriptor> {
        let descriptor = harness_descriptor(name)?;
        match self {
            Harness::Known(entry) if std::ptr::eq(*entry, descriptor) => Some(descriptor),
            _ => None,
        }
    }
}

/// A pool's harness table: the known harnesses, then whatever a pool registers by name (an override
/// keeps the name's place, a new name goes last), as `{ ...defaultHarnesses, ...poolHarnesses }`.
#[derive(Clone, Debug, Default)]
pub struct Harnesses {
    entries: Vec<(String, Harness)>,
}

impl Harnesses {
    /// The engine's own table (`defaultHarnesses`): every known harness on its batch argv.
    pub fn defaults() -> Self {
        let mut harnesses = Harnesses::default();
        for descriptor in default_harness_descriptors() {
            harnesses.insert(descriptor.name, Harness::Known(descriptor));
        }
        harnesses
    }

    /// `harnesses[name] = harness`.
    pub fn insert(&mut self, name: &str, harness: Harness) {
        match self.entries.iter_mut().find(|(entry, _)| entry == name) {
            Some((_, slot)) => *slot = harness,
            None => self.entries.push((name.to_owned(), harness)),
        }
    }

    /// Register a command under a name.
    pub fn insert_command(&mut self, name: &str, command: HarnessCommand) {
        self.insert(name, Harness::Custom(command));
    }

    pub fn get(&self, name: &str) -> Option<&Harness> {
        self.entries
            .iter()
            .find(|(entry, _)| entry == name)
            .map(|(_, harness)| harness)
    }

    pub fn contains(&self, name: &str) -> bool {
        self.get(name).is_some()
    }

    /// `Object.keys(harnesses)`: the names in table order.
    pub fn names(&self) -> Vec<String> {
        self.entries.iter().map(|(name, _)| name.clone()).collect()
    }

    /// `Object.keys(harnesses).sort()`: what the Settings pane offers.
    pub fn sorted_names(&self) -> Vec<String> {
        let mut names = self.names();
        js_compat::sort_strings(&mut names);
        names
    }

    /// The sorted names joined as every unknown-harness message lists them after "Known: ".
    pub fn known(&self) -> String {
        self.sorted_names().join(", ")
    }
}

/// The log mode a harness declares (ADR-0012): read from the descriptor, so a custom harness that is
/// not a known streamer stays raw and an unknown name can never silently stream.
pub fn harness_stream_mode(harness: &str) -> HarnessStreamMode {
    harness_descriptor(harness).map_or(HarnessStreamMode::Raw, |descriptor| descriptor.stream_mode)
}

/// The command a terminal-backed spawn hands its pane: what the TUI runs.
#[derive(Clone)]
pub enum InteractiveCommand {
    /// The descriptor's interactive argv: the registered command was the engine's own batch command.
    Known(&'static HarnessDescriptor),
    /// The registered command itself, run as the pane command under the script wrapper.
    Custom(HarnessCommand),
}

impl fmt::Debug for InteractiveCommand {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InteractiveCommand::Known(descriptor) => write!(f, "Known({})", descriptor.name),
            InteractiveCommand::Custom(_) => f.write_str("Custom(..)"),
        }
    }
}

impl InteractiveCommand {
    pub fn argv(&self, ctx: &SpawnContext) -> Vec<String> {
        match self {
            InteractiveCommand::Known(descriptor) => (descriptor.interactive_argv)(ctx),
            InteractiveCommand::Custom(command) => command(ctx),
        }
    }
}

/// The command a terminal-backed spawn hands its pane: the descriptor's interactive argv when the
/// registered command is the engine's own batch command (no override, so the TUI replaces the batch
/// flags), or the registered command itself when it is not: a pool or test that overrides a harness by
/// name owns what runs. `None` when the table has no such harness.
pub fn interactive_harness_command(
    harnesses: &Harnesses,
    harness: &str,
) -> Option<InteractiveCommand> {
    let entry = harnesses.get(harness)?;
    if let Some(descriptor) = entry.is_own_descriptor_of(harness) {
        return Some(InteractiveCommand::Known(descriptor));
    }
    Some(match entry {
        Harness::Custom(command) => InteractiveCommand::Custom(command.clone()),
        // Another known harness's batch command registered under this name: it runs as given.
        Harness::Known(descriptor) => {
            let batch = descriptor.batch_argv;
            InteractiveCommand::Custom(Arc::new(move |ctx: &SpawnContext| batch(ctx)))
        }
    })
}

/// Whether an Attempt on `harness` launched in `mode` carries its effort (CONTEXT.md: Effort): the
/// descriptor must say the mode takes one, and the registered command must be the descriptor's own. An
/// override by name, or a harness with no descriptor, counts as not applied: the Console cannot vouch
/// that its command reads the effort.
pub fn effort_applies(harnesses: &Harnesses, harness: &str, mode: HarnessMode) -> bool {
    harnesses
        .get(harness)
        .and_then(|entry| entry.is_own_descriptor_of(harness))
        .is_some_and(|descriptor| descriptor.takes_effort.get(mode))
}

/// The mode a pool's Attempts launch in (ADR-0014): the TUI when the pool is terminal-backed, the batch
/// argv otherwise.
pub fn pool_harness_mode(terminal: Option<&str>) -> HarnessMode {
    if terminal == Some("herdr") {
        HarnessMode::Interactive
    } else {
        HarnessMode::Batch
    }
}

/// The batch command an attempt's Assignment resolves to, or the pool config error naming the ticket
/// and the fix: a missing harness or model (an unassigned ticket with no defaults, ADR-0013) or a
/// harness name the table does not carry. Fired at spawn time rather than at load so the
/// misconfiguration renders on the canvas first.
pub fn harness_command_for<'a>(
    harnesses: &'a Harnesses,
    harness: &str,
    model: &str,
    ticket_id: &str,
) -> Result<&'a Harness, ConfigError> {
    if harness.is_empty() || model.is_empty() {
        let missing = if harness.is_empty() {
            "harness"
        } else {
            "model"
        };
        return Err(ConfigError(format!(
            "pool config: ticket {ticket_id} has no {missing} (set one in console.json assign or defaults)"
        )));
    }
    harnesses.get(harness).ok_or_else(|| {
        ConfigError(format!(
            "pool config: ticket {ticket_id} names unknown harness '{harness}'. Known: {}",
            harnesses.known()
        ))
    })
}

/// The placeholder an argv element carries in a spawned event's facts where the prompt body sat
/// (ADR-0012).
pub const PROMPT_PLACEHOLDER: &str = "<prompt>";

/// The argv as the spawned event records it (ADR-0012): every element that interpolates the prompt
/// body carries the placeholder in place of its first occurrence.
pub fn elide_prompt_argv(argv: &[String], body: &str) -> Vec<String> {
    if body.is_empty() {
        return argv.to_vec();
    }
    argv.iter()
        .map(|arg| arg.replacen(body, PROMPT_PLACEHOLDER, 1))
        .collect()
}

/// A descriptor's idle pattern: its own when set, else its ready pattern.
pub fn idle_pattern_for(descriptor: &HarnessDescriptor) -> &'static str {
    descriptor.idle_pattern.unwrap_or(descriptor.ready_pattern)
}

/// The environment the engine hands a harness child: the parent environment verbatim, with PWD forced
/// to the spawn cwd (an existing PWD keeps its place). The server's stale PWD would otherwise win, and
/// opencode roots its project in PWD before cwd.
pub fn spawn_env(parent: &[(String, String)], cwd: &str) -> Vec<(String, String)> {
    let mut env = parent.to_vec();
    match env.iter_mut().find(|(key, _)| key == "PWD") {
        Some((_, value)) => *value = cwd.to_owned(),
        None => env.push(("PWD".to_owned(), cwd.to_owned())),
    }
    env
}

/// The keys the engine's spawn environment sets beyond the inherited parent's, with their values: today
/// exactly PWD, derived from the actual delta so a future key cannot silently drop off the spawned
/// event.
pub fn engine_env_set(
    env: &[(String, String)],
    parent: &[(String, String)],
) -> Vec<(String, String)> {
    env.iter()
        .filter(|(key, value)| {
            parent
                .iter()
                .find(|(parent_key, _)| parent_key == key)
                .is_none_or(|(_, parent_value)| parent_value != value)
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> SpawnContext {
        SpawnContext {
            id: "01".into(),
            issue_path: "/tmp/pool/issues/01-a.md".into(),
            body: "Standing instructions for this job:\n\nDo the thing.".into(),
            driver: "implement".into(),
            harness: "claude".into(),
            model: "claude-test".into(),
            effort: None,
            log_path: "/tmp/pool/runs/01.log".into(),
            outcome_path: "/tmp/pool/runs/01.outcome.json".into(),
            exit_code_path: "/tmp/pool/runs/01.exitcode".into(),
            cwd: "/tmp/pool".into(),
            stream_path: None,
        }
    }

    fn with_effort(harness: &str, effort: &str) -> SpawnContext {
        SpawnContext {
            harness: harness.into(),
            effort: Some(effort.into()),
            ..context()
        }
    }

    fn batch(name: &str, ctx: &SpawnContext) -> Vec<String> {
        Harnesses::defaults().get(name).unwrap().batch_argv(ctx)
    }

    fn custom(argv: &'static [&'static str]) -> HarnessCommand {
        Arc::new(move |_: &SpawnContext| owned(argv))
    }

    const PROMPT: &str = "/implement /tmp/pool/issues/01-a.md\n\nStanding instructions for this job:\n\nDo the thing.";

    // spawn.test.ts: defaultHarnesses
    #[test]
    fn builds_the_claude_argv_from_the_driver_issue_reference_and_body_fields() {
        assert_eq!(
            batch("claude", &context()),
            [
                "claude",
                "-p",
                PROMPT,
                "--model",
                "claude-test",
                "--permission-mode",
                "auto",
                "--output-format",
                "stream-json",
                "--verbose",
            ]
        );
    }

    #[test]
    fn never_passes_agents_to_claude() {
        assert!(!batch("claude", &context()).contains(&"--agents".to_owned()));
        assert!(!(CLAUDE.interactive_argv)(&context()).contains(&"--agents".to_owned()));
    }

    #[test]
    fn builds_the_opencode_argv_from_the_fields_without_the_driver_line_in_the_message() {
        let argv = batch("opencode", &context());
        assert_eq!(
            argv,
            [
                "opencode",
                "run",
                "--command",
                "implement",
                "/tmp/pool/issues/01-a.md\n\nStanding instructions for this job:\n\nDo the thing.",
                "--model",
                "claude-test",
                "--auto",
            ]
        );
        assert!(!argv[3].contains("/implement"));
        assert!(!argv.contains(&"--output-format".to_owned()));
    }

    #[test]
    fn builds_the_cursor_argv_from_the_fields() {
        assert_eq!(
            batch("cursor", &context()),
            [
                "agent",
                "-p",
                PROMPT,
                "--model",
                "claude-test",
                "--force",
                "--trust",
                "--output-format",
                "stream-json",
            ]
        );
    }

    // spawn.test.ts: defaultHarnessDescriptors
    #[test]
    fn exposes_the_prototype_validated_ready_echo_and_idle_patterns() {
        assert_eq!(CLAUDE.ready_pattern, "Claude Code v");
        assert_eq!(OPENCODE.ready_pattern, "Ask anything");
        assert_eq!(CURSOR.ready_pattern, "Cursor Agent");
        assert_eq!(CLAUDE.echo_pattern, Some("Pasted text"));
        assert_eq!(CURSOR.echo_pattern, Some("Pasted text"));
        assert_eq!(OPENCODE.echo_pattern, None);
        assert_eq!(idle_pattern_for(&CLAUDE), "❯");
        assert_eq!(idle_pattern_for(&OPENCODE), "ctrl+p commands");
        assert_eq!(idle_pattern_for(&CURSOR), "Plan, search, build anything");
        for descriptor in default_harness_descriptors() {
            assert!(!descriptor.ready_pattern.is_empty());
        }
    }

    #[test]
    fn carries_the_prototype_verified_clear_keys_with_claude_empty_pending_verification() {
        assert_eq!(OPENCODE.clear_keys, ["ctrl+c"]);
        assert_eq!(CURSOR.clear_keys, ["ctrl+c"]);
        assert!(CLAUDE.clear_keys.is_empty());
    }

    #[test]
    fn is_the_single_source_the_table_and_the_stream_mode_read_from() {
        let table = Harnesses::defaults();
        assert_eq!(table.names(), ["claude", "opencode", "cursor"]);
        for descriptor in default_harness_descriptors() {
            assert!(
                matches!(table.get(descriptor.name), Some(Harness::Known(d)) if std::ptr::eq(*d, descriptor))
            );
            assert_eq!(harness_stream_mode(descriptor.name), descriptor.stream_mode);
        }
    }

    #[test]
    fn shapes_the_batch_prompt_exactly_as_the_batch_argv_embeds_it() {
        let ctx = context();
        for descriptor in default_harness_descriptors() {
            let argv = (descriptor.batch_argv)(&ctx);
            let embedded = if descriptor.name == "opencode" {
                &argv[4]
            } else {
                &argv[2]
            };
            assert_eq!(*embedded, (descriptor.prompt_shaping.batch)(ctx.shaping()));
            assert!(embedded.contains(&ctx.body));
        }
        assert_eq!((CLAUDE.prompt_shaping.batch)(ctx.shaping()), PROMPT);
        assert_eq!(
            (OPENCODE.prompt_shaping.batch)(ctx.shaping()),
            "/tmp/pool/issues/01-a.md\n\nStanding instructions for this job:\n\nDo the thing."
        );
    }

    #[test]
    fn builds_the_interactive_argv_from_the_batch_argv_minus_the_batch_only_flags() {
        let ctx = context();
        assert_eq!(
            (CLAUDE.interactive_argv)(&ctx),
            [
                "claude",
                "--model",
                "claude-test",
                "--permission-mode",
                "auto"
            ]
        );
        assert_eq!(
            (OPENCODE.interactive_argv)(&ctx),
            ["opencode", "--model", "claude-test", "--auto"]
        );
        assert_eq!(
            (CURSOR.interactive_argv)(&ctx),
            ["agent", "--model", "claude-test", "--force", "--trust"]
        );
    }

    #[test]
    fn shapes_the_interactive_prompt_the_way_each_tui_accepts_the_driver_invocation() {
        let ctx = context();
        for descriptor in default_harness_descriptors() {
            let prompt = (descriptor.prompt_shaping.interactive)(ctx.shaping());
            assert_eq!(prompt, format!("{PROMPT}\n/tmp/pool/issues/01-a.md"));
            assert_eq!(
                prompt.split('\n').next_back(),
                Some(ctx.issue_path.as_str())
            );
        }
    }

    #[test]
    fn treats_an_unknown_harness_as_raw_with_no_descriptor() {
        assert!(harness_descriptor("mystery").is_none());
        assert_eq!(harness_stream_mode("claude"), HarnessStreamMode::Stream);
        assert_eq!(harness_stream_mode("cursor"), HarnessStreamMode::Stream);
        assert_eq!(harness_stream_mode("opencode"), HarnessStreamMode::Raw);
        assert_eq!(harness_stream_mode("mystery"), HarnessStreamMode::Raw);
    }

    // spawn.test.ts: interactiveHarnessCommand
    #[test]
    fn replaces_the_engines_own_batch_command_with_the_descriptors_interactive_argv() {
        let ctx = context();
        let table = Harnesses::defaults();
        assert_eq!(
            interactive_harness_command(&table, "claude")
                .unwrap()
                .argv(&ctx),
            (CLAUDE.interactive_argv)(&ctx)
        );
        assert_eq!(
            interactive_harness_command(&table, "opencode")
                .unwrap()
                .argv(&ctx),
            ["opencode", "--model", "claude-test", "--auto"]
        );
    }

    #[test]
    fn runs_a_pool_registered_override_as_the_pane_command_as_is() {
        let command = custom(&["bash", "/tmp/pool/stub.sh"]);
        let mut table = Harnesses::defaults();
        table.insert_command("claude", command.clone());
        match interactive_harness_command(&table, "claude").unwrap() {
            InteractiveCommand::Custom(found) => assert!(Arc::ptr_eq(&found, &command)),
            other => panic!("expected the override, got {other:?}"),
        }
        let mut only = Harnesses::default();
        only.insert_command("custom", custom(&["bash", "/tmp/pool/custom.sh"]));
        assert_eq!(
            interactive_harness_command(&only, "custom")
                .unwrap()
                .argv(&context()),
            ["bash", "/tmp/pool/custom.sh"]
        );
        assert!(interactive_harness_command(&only, "claude").is_none());
        // Another harness's own command under this name runs as given, in its batch form.
        let mut swapped = Harnesses::defaults();
        swapped.insert("claude", Harness::Known(&OPENCODE));
        assert_eq!(
            interactive_harness_command(&swapped, "claude")
                .unwrap()
                .argv(&context())[1],
            "run"
        );
    }

    // spawn.test.ts: effort (CONTEXT.md: Effort)
    #[test]
    fn passes_claudes_effort_in_both_modes_verbatim() {
        let ctx = with_effort("claude", "high");
        for argv in [(CLAUDE.batch_argv)(&ctx), (CLAUDE.interactive_argv)(&ctx)] {
            let at = argv.iter().position(|arg| arg == "--effort").unwrap();
            assert_eq!(argv[at + 1], "high");
        }
        assert_eq!(
            (CLAUDE.interactive_argv)(&ctx),
            [
                "claude",
                "--model",
                "claude-test",
                "--effort",
                "high",
                "--permission-mode",
                "auto"
            ]
        );
    }

    #[test]
    fn passes_opencodes_run_variant_and_nothing_to_its_tui() {
        let ctx = with_effort("opencode", "minimal");
        let argv = (OPENCODE.batch_argv)(&ctx);
        let at = argv.iter().position(|arg| arg == "--variant").unwrap();
        assert_eq!(argv[at + 1], "minimal");
        assert_eq!(argv.last().unwrap(), "--auto");
        assert_eq!(
            (OPENCODE.interactive_argv)(&ctx),
            ["opencode", "--model", "claude-test", "--auto"]
        );
    }

    #[test]
    fn gives_cursor_nothing_in_either_mode_and_never_folds_it_into_the_model() {
        let ctx = with_effort("cursor", "high");
        let bare = SpawnContext {
            harness: "cursor".into(),
            ..context()
        };
        assert_eq!((CURSOR.batch_argv)(&ctx), (CURSOR.batch_argv)(&bare));
        assert_eq!(
            (CURSOR.interactive_argv)(&ctx),
            (CURSOR.interactive_argv)(&bare)
        );
    }

    #[test]
    fn adds_no_flag_at_all_when_the_assignment_names_no_effort() {
        for descriptor in default_harness_descriptors() {
            for argv in [
                (descriptor.batch_argv)(&context()),
                (descriptor.interactive_argv)(&context()),
            ] {
                assert!(
                    !argv
                        .iter()
                        .any(|arg| arg == "--effort" || arg == "--variant")
                );
            }
        }
        // An empty effort is no effort.
        assert_eq!(
            (CLAUDE.batch_argv)(&with_effort("claude", "")),
            (CLAUDE.batch_argv)(&context())
        );
    }

    #[test]
    fn declares_exactly_the_modes_whose_argv_carries_the_effort() {
        for descriptor in default_harness_descriptors() {
            let ctx = with_effort(descriptor.name, "sentinel-effort");
            let carries = |argv: Vec<String>| argv.iter().any(|arg| arg == "sentinel-effort");
            assert_eq!(
                carries((descriptor.batch_argv)(&ctx)),
                descriptor.takes_effort.batch
            );
            assert_eq!(
                carries((descriptor.interactive_argv)(&ctx)),
                descriptor.takes_effort.interactive
            );
        }
    }

    #[test]
    fn applies_only_on_the_engines_own_command_in_a_mode_that_takes_it() {
        let table = Harnesses::defaults();
        assert!(effort_applies(&table, "claude", HarnessMode::Batch));
        assert!(effort_applies(&table, "claude", HarnessMode::Interactive));
        assert!(effort_applies(&table, "opencode", HarnessMode::Batch));
        assert!(!effort_applies(
            &table,
            "opencode",
            HarnessMode::Interactive
        ));
        assert!(!effort_applies(&table, "cursor", HarnessMode::Batch));
        assert!(!effort_applies(&table, "cursor", HarnessMode::Interactive));
        let mut overridden = Harnesses::defaults();
        overridden.insert_command("claude", custom(&["bash", "/tmp/pool/stub.sh"]));
        assert!(!effort_applies(&overridden, "claude", HarnessMode::Batch));
        let mut only = Harnesses::default();
        only.insert_command("custom", custom(&["bash"]));
        assert!(!effort_applies(&only, "custom", HarnessMode::Batch));
        assert!(!effort_applies(&table, "mystery", HarnessMode::Batch));
    }

    #[test]
    fn reads_a_terminal_backed_pool_as_the_tui_and_any_other_as_batch() {
        assert_eq!(pool_harness_mode(Some("herdr")), HarnessMode::Interactive);
        assert_eq!(pool_harness_mode(None), HarnessMode::Batch);
    }

    #[test]
    fn names_the_ticket_and_the_fix_when_no_command_resolves() {
        let table = Harnesses::defaults();
        assert_eq!(
            harness_command_for(&table, "", "", "01").unwrap_err().0,
            "pool config: ticket 01 has no harness (set one in console.json assign or defaults)"
        );
        assert_eq!(
            harness_command_for(&table, "claude", "", "01")
                .unwrap_err()
                .0,
            "pool config: ticket 01 has no model (set one in console.json assign or defaults)"
        );
        assert_eq!(
            harness_command_for(&table, "gemini", "m", "02")
                .unwrap_err()
                .0,
            "pool config: ticket 02 names unknown harness 'gemini'. Known: claude, cursor, opencode"
        );
        assert!(harness_command_for(&table, "claude", "m", "01").is_ok());
    }

    // spawn.test.ts: elidePromptArgv
    #[test]
    fn replaces_the_body_with_the_placeholder_and_leaves_every_other_element_alone() {
        let body = "the whole prompt, many lines";
        let argv: Vec<String> = owned(&[
            "claude",
            "-p",
            &format!("/implement /p/01.md\n\n{body}"),
            "--model",
            "m",
        ]);
        assert_eq!(
            elide_prompt_argv(&argv, body),
            [
                "claude",
                "-p",
                "/implement /p/01.md\n\n<prompt>",
                "--model",
                "m"
            ]
        );
        let argv = owned(&[body, "keep", &format!("{body} suffix")]);
        assert_eq!(
            elide_prompt_argv(&argv, body),
            ["<prompt>", "keep", "<prompt> suffix"]
        );
        assert_eq!(elide_prompt_argv(&owned(&["a", "b"]), body), ["a", "b"]);
        assert_eq!(elide_prompt_argv(&owned(&["a"]), ""), ["a"]);
        // Only the first occurrence in an element, as String.prototype.replace does.
        assert_eq!(elide_prompt_argv(&owned(&["x x"]), "x"), ["<prompt> x"]);
    }

    // spawn.test.ts: engineEnvSet
    #[test]
    fn reports_the_keys_the_spawn_env_changes_from_the_parent_environment() {
        let parent = vec![
            ("HOME".to_owned(), "/home/op".to_owned()),
            ("PWD".to_owned(), "/checkout".to_owned()),
        ];
        let env = spawn_env(&parent, "/spawn/cwd");
        assert_eq!(env[1], ("PWD".to_owned(), "/spawn/cwd".to_owned()));
        assert_eq!(
            engine_env_set(&env, &parent),
            [("PWD".to_owned(), "/spawn/cwd".to_owned())]
        );
        assert!(engine_env_set(&parent, &parent).is_empty());
        let without_pwd = vec![("HOME".to_owned(), "/home/op".to_owned())];
        assert_eq!(
            spawn_env(&without_pwd, "/c").last().unwrap(),
            &("PWD".to_owned(), "/c".to_owned())
        );
    }
}
