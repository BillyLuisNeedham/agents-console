//! Boot (issue #121, ADR-0026; boot-cli.ts): starting a Console for a Pool without an agent.
//! `agent-console` from a project checkout finds or creates the Pool, reads everything it can rather
//! than asking, interviews only for what is still missing, writes the Pool's config and its prose
//! files, and starts the server.
//!
//! The interview used to be the `my-console-runner` skill's step 2, eight questions an agent asked and
//! answered into files. Almost all of it was bookkeeping a program does better and cheaper, so the
//! skill now runs this and keeps the one part a program cannot do, which is writing the pool's own
//! prose. A Restart hands off here too: the Console stops its server and re-execs this with `--yes
//! --relaunch`, which is why every question has a prefill good enough to take unattended.
//!
//! The prompts go through one [`BootIo`], and the process work is behind the small functions in
//! [`launch`], so the decisions are testable without a terminal. Boot no longer builds the Console
//! (ADR-0036): the release binary embeds the UI and the shim rebuilds a stale binary.

pub mod config;
pub mod detect;
pub mod launch;
pub mod pool;

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::Path;

use ac_core::js;
use ac_core::machine_defaults::{
    default_machine_defaults_path, default_machine_defaults_paths, read_machine_defaults,
    write_machine_defaults,
};
use ac_core::pool_title::normalise_title;
use serde_json::{Map, Value};

use config::{
    AgentFill, BootAnswers, PortAnswer, Prefill, TerminalAnswer, fill_agent_template, list_setups,
    merge_console_config, merge_prefill, prefill_from_config, prefill_from_detection,
    prefill_from_machine_defaults, prefill_from_setup, read_console_config, read_setup,
    refresh_agent_head, setup_from_config, setup_path, write_console_config, write_setup,
};
use detect::{Detection, KNOWN_HARNESSES, detect};
use launch::{BootVerdict, PidRelease, PoolLockFile};
use pool::{
    Excluded, PoolResolution, RealRepoProbe, create_pool, dirname, ensure_scratch_excluded,
    free_slug, git_dir_of, git_line, nearest_existing, pool_choice_line, resolve_pool, slugify,
};

pub const USAGE: &str = "usage: agent-console [pool-dir] [--yes] [--relaunch] [--port <n>] [--setup <name>] [--no-open]";

/// Boot's flags, kept deliberately few.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootArgs {
    pub pool_dir: Option<String>,
    pub yes: bool,
    pub relaunch: bool,
    pub port: Option<u16>,
    pub setup: Option<String>,
    pub open: bool,
}

/// A command line Boot will not run: the usage asked for, or a refusal to print.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArgRefusal {
    pub message: String,
    pub help: bool,
}

fn refusal(message: String) -> ArgRefusal {
    ArgRefusal {
        message,
        help: false,
    }
}

/// The flags. `--pool` is the positional's long form because the Console's Restart handoff builds a
/// command line rather than a shell invocation and naming the flag reads better there.
pub fn parse_boot_args(argv: &[String]) -> Result<BootArgs, ArgRefusal> {
    let mut args = BootArgs {
        pool_dir: None,
        yes: false,
        relaunch: false,
        port: None,
        setup: None,
        open: true,
    };
    let mut i = 0;
    while i < argv.len() {
        let arg = argv[i].as_str();
        match arg {
            "--yes" | "-y" => args.yes = true,
            "--relaunch" => args.relaunch = true,
            "--no-open" => args.open = false,
            "--help" | "-h" => {
                return Err(ArgRefusal {
                    message: USAGE.to_owned(),
                    help: true,
                });
            }
            "--pool" | "--port" | "--setup" => {
                let Some(value) = argv.get(i + 1).filter(|value| !value.starts_with("--")) else {
                    return Err(refusal(format!("{arg} needs a value\n{USAGE}")));
                };
                i += 1;
                match arg {
                    "--pool" => args.pool_dir = Some(value.clone()),
                    "--setup" => args.setup = Some(value.clone()),
                    _ => {
                        let port = js::number_from_text(value);
                        if !port.is_finite() || port.fract() != 0.0 {
                            return Err(refusal(format!("--port must be a number, got {value}")));
                        }
                        if !(0.0..=65535.0).contains(&port) {
                            return Err(refusal(format!(
                                "--port: port must be an integer 0-65535, got {}",
                                js::number_string(port)
                            )));
                        }
                        args.port = Some(port as u16);
                    }
                }
            }
            _ if arg.starts_with('-') => {
                return Err(refusal(format!("unknown flag {arg}\n{USAGE}")));
            }
            _ if args.pool_dir.is_none() => args.pool_dir = Some(arg.to_owned()),
            _ => return Err(refusal(format!("too many arguments\n{USAGE}"))),
        }
        i += 1;
    }
    Ok(args)
}

/// One prompt, one line, and Boot's two streams. The default is what pressing Enter gives you.
pub trait BootIo {
    fn ask(&mut self, question: &str, fallback: &str) -> String;
    fn log(&mut self, line: &str);
    fn warn(&mut self, line: &str);
}

fn print_line(line: &str) {
    let _ = writeln!(std::io::stdout(), "{line}");
}

fn print_error(line: &str) {
    let _ = writeln!(std::io::stderr(), "{line}");
}

/// The ask that refuses to ask, for `--yes` and for the Restart handoff.
pub struct SilentIo;

impl BootIo for SilentIo {
    fn ask(&mut self, _question: &str, fallback: &str) -> String {
        fallback.to_owned()
    }
    fn log(&mut self, line: &str) {
        print_line(line);
    }
    fn warn(&mut self, line: &str) {
        print_error(line);
    }
}

/// The terminal's ask. It reads lines from one long-lived stream rather than asking for a line per
/// question: answers piped in arrive as a block, and every one of them must reach the question it
/// answers. Lines end at `\n`, `\r\n` or a lone `\r`, as readline splits them. Input ending is not a
/// failure either, so from that point every remaining question takes its default, exactly as `--yes`
/// would.
pub struct TerminalIo<R: Read> {
    input: R,
    partial: Vec<u8>,
    ready: VecDeque<String>,
    ended: bool,
    saw_return: bool,
}

impl<R: Read> TerminalIo<R> {
    pub fn new(input: R) -> Self {
        TerminalIo {
            input,
            partial: Vec::new(),
            ready: VecDeque::new(),
            ended: false,
            saw_return: false,
        }
    }

    fn take_partial(&mut self) {
        let bytes = std::mem::take(&mut self.partial);
        self.ready
            .push_back(String::from_utf8_lossy(&bytes).into_owned());
    }

    fn feed(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            if std::mem::take(&mut self.saw_return) && byte == b'\n' {
                continue;
            }
            match byte {
                b'\n' => self.take_partial(),
                b'\r' => {
                    self.take_partial();
                    self.saw_return = true;
                }
                other => self.partial.push(other),
            }
        }
    }

    /// The next line, or `None` once the input has ended and every line was taken.
    pub fn next_line(&mut self) -> Option<String> {
        loop {
            if let Some(line) = self.ready.pop_front() {
                return Some(line);
            }
            if self.ended {
                return None;
            }
            let mut chunk = [0u8; 4096];
            match self.input.read(&mut chunk) {
                Ok(0) => {
                    self.ended = true;
                    if !self.partial.is_empty() {
                        self.take_partial();
                    }
                }
                Ok(n) => self.feed(&chunk[..n]),
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => self.ended = true,
            }
        }
    }
}

impl<R: Read> BootIo for TerminalIo<R> {
    fn ask(&mut self, question: &str, fallback: &str) -> String {
        let suffix = if fallback.is_empty() {
            String::new()
        } else {
            format!(" [{fallback}]")
        };
        let mut out = std::io::stdout();
        let _ = write!(out, "{question}{suffix}: ");
        let _ = out.flush();
        let Some(line) = self.next_line() else {
            let _ = writeln!(out);
            return fallback.to_owned();
        };
        let answer = js::trim(&line);
        if answer.is_empty() {
            fallback.to_owned()
        } else {
            answer.to_owned()
        }
    }
    fn log(&mut self, line: &str) {
        print_line(line);
    }
    fn warn(&mut self, line: &str) {
        print_error(line);
    }
}

/// `agent-console boot [pool-dir] [flags]`: the whole of Boot, answering the exit code.
pub fn run(args: Vec<String>) -> i32 {
    let unattended = args
        .iter()
        .any(|arg| arg == "--yes" || arg == "-y" || arg == "--relaunch");
    let mut io: Box<dyn BootIo> = if unattended {
        Box::new(SilentIo)
    } else {
        Box::new(TerminalIo::new(std::io::stdin()))
    };
    let home = home_dir();
    match run_boot(&args, io.as_mut(), &home) {
        Ok(code) => code,
        Err(message) => {
            io.warn(&message);
            1
        }
    }
}

/// The home directory as Node's `os.homedir()` reads it: `$HOME` when set, else the password
/// database. Only the CLI reads the environment; everything below takes the answer as an argument.
pub(crate) fn home_dir() -> String {
    if let Some(home) = std::env::var_os("HOME") {
        return home.to_string_lossy().into_owned();
    }
    nix::unistd::User::from_uid(nix::unistd::getuid())
        .ok()
        .flatten()
        .map(|user| js::path_text(&user.dir))
        .unwrap_or_default()
}

/// Run a future to completion on a runtime of its own, on a thread of its own, so a command line works
/// the same whether or not it was called from inside a tokio runtime.
pub(crate) fn on_own_runtime<F>(future: F) -> Option<F::Output>
where
    F: std::future::Future + Send,
    F::Output: Send,
{
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .ok()
                    .map(|runtime| runtime.block_on(future))
            })
            .join()
            .ok()
            .flatten()
    })
}

/// Where the engine lives: the machine default when it names a directory that is there, else the
/// checkout this binary was built from.
pub fn engine_checkout(configured: Option<&str>) -> String {
    if let Some(dir) = configured.filter(|dir| !dir.is_empty() && js::exists(dir)) {
        return dir.to_owned();
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .and_then(Path::parent)
        .map(js::path_text)
        .unwrap_or_else(|| js::path_text(manifest))
}

/// Which Pool, and say why. The interactive branches are the only reason this is not simply
/// [`resolve_pool`]: several pools under one `.scratch/` is a choice, and no pool at all is a name.
/// Answers the pool directory and, for a pool it created, the title it was given.
fn choose_pool(
    args: &BootArgs,
    io: &mut dyn BootIo,
    cwd: &str,
) -> Result<(String, Option<String>), String> {
    let explicit = args
        .pool_dir
        .as_deref()
        .filter(|dir| !dir.is_empty())
        .map(js::path_resolve);
    match resolve_pool(explicit.as_deref(), cwd, &RealRepoProbe) {
        PoolResolution::NoRepo { cwd } => Err(format!(
            "{cwd} is not a pool and not inside a git checkout. A pool lives beside the checkout \
             its attempts branch from, so run this from a project or name the pool directory."
        )),
        PoolResolution::Found { dir, why } => {
            io.log(&format!("pool: {dir} ({why})"));
            // A pool found or named under a project's `.scratch/` gets the same exclude line a
            // created one does. The directory is this machine's working material either way, and
            // the line is missing exactly when the first pool was made by hand rather than by Boot.
            exclude_scratch(&dir, io);
            Ok((dir, None))
        }
        PoolResolution::Several {
            candidates,
            scratch,
        } => {
            if args.yes {
                let listed: Vec<String> = candidates.iter().map(|dir| format!("  {dir}")).collect();
                return Err(format!(
                    "several pools under {scratch}; name the one you want:\n{}",
                    listed.join("\n")
                ));
            }
            io.log(&format!("pools under {scratch}:"));
            for (index, dir) in candidates.iter().enumerate() {
                io.log(&format!("  {}. {}", index + 1, pool_choice_line(dir)));
            }
            let picked = io.ask("which pool", "1");
            let index = js::number_from_text(&picked) - 1.0;
            let dir = (index.fract() == 0.0 && index >= 0.0)
                .then(|| candidates.get(index as usize))
                .flatten()
                .ok_or_else(|| format!("no pool numbered {picked}"))?;
            io.log(&format!("pool: {dir} (chosen)"));
            Ok((dir.clone(), None))
        }
        PoolResolution::Create {
            scratch,
            suggested,
            why,
        } => {
            let (title, slug) = name_new_pool(io, &scratch, &suggested, args.yes);
            let top = dirname(&scratch);
            let (dir, excluded) = create_pool(&scratch, &slug, &git_dir_of(&top))?;
            io.log(&format!("pool: {dir} (created, {why})"));
            match excluded {
                Excluded::Added => io.log(&format!("added .scratch/ to {top}/.git/info/exclude")),
                Excluded::Unavailable => io.warn(&format!(
                    "could not write {top}/.git/info/exclude; add .scratch/ to it yourself"
                )),
                Excluded::Present => {}
            }
            Ok((dir, title))
        }
    }
}

/// A new Pool's title and directory (issue #100). The title comes first, because it is how the
/// operator will know the pool, and the directory is derived from it: its slug, else the branch's,
/// made free under `.scratch/` and offered for confirmation. A blank title is no title, and the pool is
/// known by its directory, exactly as before titles. Unattended, nothing is asked: no title, and the
/// branch's slug.
pub fn name_new_pool(
    io: &mut dyn BootIo,
    scratch: &str,
    suggested: &str,
    unattended: bool,
) -> (Option<String>, String) {
    let title = if unattended {
        None
    } else {
        normalise_title(&io.ask("title for the new pool (blank for none)", ""))
    };
    let base = title
        .as_deref()
        .map(slugify)
        .filter(|slug| !slug.is_empty())
        .unwrap_or_else(|| suggested.to_owned());
    let derived = free_slug(scratch, &base);
    if unattended {
        return (title, derived);
    }
    let answer = io.ask("directory for the new pool", &derived);
    let mut slug = slugify(&answer);
    if slug.is_empty() {
        slug = derived;
    }
    let free = free_slug(scratch, &slug);
    if free != slug {
        io.warn(&format!("{slug} is already under {scratch}; using {free}"));
        slug = free;
    }
    (title, slug)
}

/// Keep `.scratch/` out of the project's history when the pool lives there. A pool somewhere else is
/// the operator's own arrangement and is left alone.
fn exclude_scratch(pool_dir: &str, io: &mut dyn BootIo) {
    let scratch = dirname(pool_dir);
    if js::basename(&scratch) != ".scratch" {
        return;
    }
    let Some(top) = git_line(
        &nearest_existing(pool_dir),
        &["rev-parse", "--show-toplevel"],
    ) else {
        return;
    };
    if dirname(&scratch) != top {
        return;
    }
    if ensure_scratch_excluded(&git_dir_of(&top)) == Excluded::Added {
        io.log(&format!("added .scratch/ to {top}'s git exclude file"));
    }
}

/// What detection found, in one short brief, because Boot asks nothing about it.
fn report_detection(io: &mut dyn BootIo, detection: &Detection) {
    let or = |list: &[String], none: &str| {
        if list.is_empty() {
            none.to_owned()
        } else {
            list.join(", ")
        }
    };
    io.log(&format!(
        "detected: {} ticket(s), conversations/ {}, context files {}, commit prefix {}",
        detection.tickets,
        if detection.conversations {
            "present"
        } else {
            "absent"
        },
        or(&detection.context_files, "none"),
        detection.commit_prefix.as_deref().unwrap_or("none"),
    ));
    io.log(&format!(
        "detected: harnesses {}, herdr {}/{}, port 8787 {}, engine {}",
        or(&detection.harnesses, "none on PATH"),
        if detection.herdr_binary {
            "installed"
        } else {
            "absent"
        },
        if detection.herdr_socket {
            "socket live"
        } else {
            "no socket"
        },
        if detection.default_port_free {
            "free"
        } else {
            "busy"
        },
        detection.engine_dir,
    ));
}

/// What the interview settled.
#[derive(Debug, Clone, PartialEq)]
pub struct InterviewResult {
    pub answers: BootAnswers,
    pub seeded: bool,
    /// Whether any question was actually put to the operator.
    pub asked: bool,
    /// A field the unattended path could not fill, which is fatal.
    pub missing: Vec<&'static str>,
}

/// The example the skill recommended, kept as this question's default.
pub const CHECKPOINT_EXAMPLE: &str =
    "a device, an external write, an undecided decision, or a material guess";

/// The questions Boot still has to ask. `prefill` is every source merged, which is what each question
/// offers as its default; `settled` is config, Setup and Machine defaults only, and a field it settles
/// is not asked. Unattended, every default is taken without asking.
pub fn interview(
    io: &mut dyn BootIo,
    prefill: &Prefill,
    settled: &Prefill,
    detection: &Detection,
    unattended: bool,
) -> InterviewResult {
    let mut answers = BootAnswers::default();
    let mut asked = false;
    let mut put = |io: &mut dyn BootIo, question: &str, fallback: &str| -> String {
        if unattended {
            return fallback.to_owned();
        }
        asked = true;
        io.ask(question, fallback)
    };

    // The pool kind, and only when the disk cannot say. A directory holding tickets is a ticket pool
    // and a directory holding conversations/ is a Seeded Pool; an empty one means opposite things on
    // the two paths and only the operator knows which (ADR-0024).
    let mut seeded = prefill.seeded.unwrap_or(true);
    if detection.tickets == 0 && !detection.conversations {
        let answer = put(io, "pool kind, ticket or seeded", "seeded");
        seeded = !answer.to_lowercase().starts_with('t');
    }

    // A field a prefill settled is not asked, but it is still written: the Pool carries its own config
    // as data, so a default that came from the machine or from a Setup has to land in this pool's file
    // rather than being looked up again at every boot. Effort is only ever carried this way: the
    // interview never asks it, the Settings pane edits it.
    answers.harness = settled.harness.clone();
    answers.model = settled.model.clone();
    answers.effort = settled.effort.clone();
    answers.drivers = settled.drivers.clone();
    answers.reviewer = settled.reviewer.clone();
    answers.checkpoint = settled.checkpoint.clone();
    answers.resolver = settled.resolver.clone();

    if settled.harness.is_none() {
        loop {
            let fallback = prefill
                .harness
                .clone()
                .or_else(|| detection.harnesses.first().cloned())
                .unwrap_or_default();
            let harness = put(
                io,
                &format!("default harness ({})", KNOWN_HARNESSES.join("/")),
                &fallback,
            );
            if harness.is_empty() {
                break;
            }
            if !KNOWN_HARNESSES.contains(&harness.as_str()) {
                io.warn(&format!(
                    "the engine has no descriptor for {harness}; pick one of {}",
                    KNOWN_HARNESSES.join(", ")
                ));
                if unattended {
                    break;
                }
                continue;
            }
            if !detection.harnesses.contains(&harness) {
                io.warn(&format!(
                    "{harness} is not on PATH; the first attempt will fail until it is"
                ));
            }
            answers.harness = Some(harness);
            break;
        }
    }
    if settled.model.is_none() {
        let model = put(io, "default model", prefill.model.as_deref().unwrap_or(""));
        if !model.is_empty() {
            answers.model = Some(model);
        }
    }
    if settled.drivers.is_none() {
        let drivers = put(
            io,
            "drivers (space separated chain)",
            prefill.drivers.as_deref().unwrap_or("implement"),
        );
        if !drivers.is_empty() {
            answers.drivers = Some(drivers);
        }
    }
    if settled.resolver.is_none() {
        let fallback = [
            resolver_text(prefill.resolver.as_ref()),
            answers.harness.clone().unwrap_or_default(),
            prefill.harness.clone().unwrap_or_default(),
        ]
        .into_iter()
        .find(|text| !text.is_empty())
        .unwrap_or_else(|| "none".to_owned());
        let resolver = put(io, "merge resolver harness (or none)", &fallback);
        if !resolver.is_empty() {
            answers.resolver = Some(Value::String(resolver));
        }
    }
    if settled.reviewer.is_none() {
        let reviewer = put(
            io,
            "reviewer and its authority (blank for none)",
            prefill.reviewer.as_deref().unwrap_or(""),
        );
        if !reviewer.is_empty() {
            answers.reviewer = Some(reviewer);
        }
    }
    if settled.checkpoint.is_none() {
        let checkpoint = put(
            io,
            "what counts as a checkpoint here",
            prefill.checkpoint.as_deref().unwrap_or(CHECKPOINT_EXAMPLE),
        );
        if !checkpoint.is_empty() {
            answers.checkpoint = Some(checkpoint);
        }
    }
    if settled.port.is_none() {
        loop {
            let port = put(
                io,
                "port to pin (auto for 8787 or next free)",
                &port_text(prefill.port.as_ref()),
            );
            if port.is_empty() || port.to_lowercase() == "auto" {
                // Only an explicit answer clears an existing pin; leaving the question alone on a pool
                // that had none is not a change.
                if prefill.port.is_some() {
                    answers.port = Some(PortAnswer::Auto);
                }
                break;
            }
            let parsed = js::number_from_text(&port);
            if !parsed.is_finite() || parsed.fract() != 0.0 || !(0.0..=65535.0).contains(&parsed) {
                io.warn("a port is an integer 0-65535, or auto");
                if unattended {
                    break;
                }
                continue;
            }
            answers.port = Some(PortAnswer::Pin(js::number_value(parsed)));
            break;
        }
    } else if let Some(port) = &prefill.port {
        answers.port = Some(PortAnswer::Pin(port.clone()));
    }
    answers.terminal = Some(if settled.terminal {
        TerminalAnswer::Herdr
    } else {
        let backed = put(
            io,
            "terminal-backed attempts in herdr tabs (yes/no)",
            if prefill.terminal { "yes" } else { "no" },
        );
        if backed.to_lowercase().starts_with('y') {
            TerminalAnswer::Herdr
        } else {
            TerminalAnswer::None
        }
    });

    let filled = |value: &Option<String>| value.as_deref().is_some_and(|value| !value.is_empty());
    let mut missing = Vec::new();
    if !filled(&answers.harness) && !filled(&settled.harness) && !filled(&prefill.harness) {
        missing.push("harness");
    }
    if !filled(&answers.model) && !filled(&settled.model) && !filled(&prefill.model) {
        missing.push("model");
    }
    InterviewResult {
        answers,
        seeded,
        asked,
        missing,
    }
}

fn resolver_text(value: Option<&Value>) -> String {
    match value {
        None => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Object(fields)) => match fields.get("harness") {
            None | Some(Value::Null) => String::new(),
            Some(harness) => js::string_of(harness),
        },
        Some(other) => js::string_of(other),
    }
}

fn port_text(port: Option<&Value>) -> String {
    port.map_or_else(|| "auto".to_owned(), js::string_of)
}

/// JavaScript's truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// A config value a template literal would print, when it is truthy.
fn printed(config: &Map<String, Value>, key: &str) -> Option<String> {
    config
        .get(key)
        .filter(|value| truthy(value))
        .map(js::string_of)
}

/// The pool's prose files, written when they are missing. The pool's own half of an `AGENT.md` that is
/// already there is never overwritten; the engine's half is [`refresh_agent_md`]'s, which runs on every
/// Boot.
fn write_prose_files(
    pool_dir: &str,
    engine_dir: &str,
    io: &mut dyn BootIo,
    detection: &Detection,
    merged: &Map<String, Value>,
) -> Result<(), String> {
    let templates = js::path_join(&[engine_dir, "skills", "my-console-runner"]);
    let agent_path = js::path_join(&[pool_dir, "AGENT.md"]);
    if !js::exists(&agent_path) {
        let template = js::path_join(&[&templates, "AGENT.template.md"]);
        if js::exists(&template) {
            let text = js::read_text(&template).map_err(|err| err.to_string())?;
            let filled = fill_agent_template(
                &text,
                &AgentFill {
                    context_files: detection.context_files.clone(),
                    commit_prefix: detection.commit_prefix.clone(),
                    reviewer: printed(merged, "reviewer"),
                    checkpoint: printed(merged, "checkpoint"),
                },
            );
            js::write_file(&agent_path, &filled).map_err(|err| err.to_string())?;
            io.log("wrote AGENT.md from the template");
        } else {
            io.warn(&format!(
                "no AGENT.template.md under {templates}; wrote no AGENT.md"
            ));
        }
    }
    let verify_path = js::path_join(&[pool_dir, "verify.md"]);
    if js::exists(&verify_path) {
        io.log("verify.md is already there; left as it is");
    } else {
        let template = js::path_join(&[&templates, "verify.template.md"]);
        if js::exists(&template) {
            std::fs::copy(&template, &verify_path).map_err(|err| {
                format!(
                    "{} -> '{verify_path}'",
                    js::FsError::new(&err, "copyfile", &template)
                )
            })?;
            io.log("wrote verify.md from the template");
        }
    }
    Ok(())
}

/// The engine's half of the pool's `AGENT.md`, brought up to the current template on every Boot, a
/// Restart's included (issue #155): a pool booted before the template changed would otherwise teach its
/// agents the old engine prose for as long as it lives. The pool's half, below the CONFIG marker, is
/// kept byte for byte. A missing file is [`write_prose_files`]' job, and a file with no marker is left
/// alone, because nothing says where its engine half ends.
pub fn refresh_agent_md(
    pool_dir: &str,
    engine_dir: &str,
    io: &mut dyn BootIo,
) -> Result<(), String> {
    let agent_path = js::path_join(&[pool_dir, "AGENT.md"]);
    let template_path = js::path_join(&[
        engine_dir,
        "skills",
        "my-console-runner",
        "AGENT.template.md",
    ]);
    if !js::exists(&agent_path) || !js::exists(&template_path) {
        return Ok(());
    }
    let current = std::fs::read(&agent_path)
        .map_err(|err| js::FsError::new(&err, "open", &agent_path).to_string())?;
    let template = js::read_text(&template_path).map_err(|err| err.to_string())?;
    match refresh_agent_head(&current, &template) {
        None => io.log("AGENT.md has no CONFIG marker; left as it is"),
        Some(refreshed) if refreshed != current => {
            std::fs::write(&agent_path, &refreshed)
                .map_err(|err| js::FsError::new(&err, "open", &agent_path).to_string())?;
            io.log("refreshed AGENT.md above the CONFIG marker from the template");
        }
        Some(_) => {}
    }
    Ok(())
}

/// Offer to keep this pool's behavioural slice for the next pool.
fn offer_setup(io: &mut dyn BootIo, config: &Map<String, Value>, home: &str) -> Result<(), String> {
    let name = io.ask("save this Setup as (blank to skip)", "");
    if name.is_empty() {
        return Ok(());
    }
    let slug = slugify(&name);
    if slug.is_empty() {
        io.warn("that name slugifies to nothing; saved no Setup");
        return Ok(());
    }
    if js::exists(setup_path(&slug, home)) {
        let confirm = io.ask(&format!("{slug} already exists; replace it (yes/no)"), "no");
        if !confirm.to_lowercase().starts_with('y') {
            io.log("left the existing Setup alone");
            return Ok(());
        }
    }
    let file = write_setup(&slug, &setup_from_config(config), home)?;
    io.log(&format!("saved Setup {slug} to {file}"));
    Ok(())
}

/// The whole of Boot, answering the exit code rather than taking it. An `Err` is a message Boot prints
/// on its way out with 1.
pub fn run_boot(argv: &[String], io: &mut dyn BootIo, home: &str) -> Result<i32, String> {
    let args = match parse_boot_args(argv) {
        Ok(args) => args,
        Err(ArgRefusal {
            message,
            help: true,
        }) => {
            io.log(&message);
            return Ok(0);
        }
        Err(ArgRefusal { message, .. }) => return Err(message),
    };
    let machine = read_machine_defaults(&default_machine_defaults_paths(home));
    let engine_dir = engine_checkout(machine.engine.as_deref());
    let cwd = std::env::current_dir()
        .map(|dir| js::path_text(&dir))
        .map_err(|err| err.to_string())?;

    let (pool_dir, new_title) = choose_pool(&args, io, &cwd)?;
    let existing = read_console_config(&pool_dir)?;
    let had_config = js::exists(js::path_join(&[&pool_dir, "console.json"]));

    // A pool named on the command line may not exist yet, so the checkout question is asked at the
    // nearest directory that does.
    let toplevel = ["rev-parse", "--show-toplevel"];
    let repo_dir = git_line(&nearest_existing(&pool_dir), &toplevel)
        .or_else(|| git_line(&cwd, &toplevel))
        .unwrap_or_else(|| pool_dir.clone());
    let detection = detect(&pool_dir, &repo_dir, &engine_dir, home);
    report_detection(io, &detection);

    // The Setup, chosen or named. Only a pool with no config of its own is offered one: a configured
    // pool already answered these questions.
    let mut setup: Option<Map<String, Value>> = None;
    if let Some(name) = args.setup.as_deref().filter(|name| !name.is_empty()) {
        setup = read_setup(name, home);
        if setup.is_none() {
            return Err(format!(
                "no Setup named {name} under ~/.agent-graphs/setups/"
            ));
        }
        io.log(&format!("starting from Setup {name}"));
    } else if !had_config && !args.yes && !args.relaunch {
        let names = list_setups(home);
        if !names.is_empty() {
            io.log(&format!("Setups: {}", names.join(", ")));
            let picked = io.ask("start from which Setup (none to skip)", "none");
            if picked.to_lowercase() != "none" {
                setup = read_setup(&picked, home);
                if setup.is_none() {
                    io.warn(&format!(
                        "no Setup named {picked}; carrying on un-prefilled"
                    ));
                }
            }
        }
    }

    let mut sources = vec![prefill_from_config(&existing)];
    if let Some(setup) = &setup {
        sources.push(prefill_from_setup(setup));
    }
    sources.push(prefill_from_machine_defaults(&machine));
    let settled = merge_prefill(&sources);
    let prefill = merge_prefill(&[settled.clone(), prefill_from_detection(&detection)]);

    let unattended = args.yes || args.relaunch;
    let mut result = interview(io, &prefill, &settled, &detection, unattended);
    if let Some(title) = new_title {
        result.answers.title = Some(title);
    }
    if unattended && !result.missing.is_empty() && !args.relaunch {
        return Err(format!(
            "nothing prefilled the {}; set it in ~/.agent-graphs/defaults.json, pass --setup, or \
             boot without --yes",
            result.missing.join(" and ")
        ));
    }

    if !args.relaunch {
        js::mkdir_all(js::path_join(&[&pool_dir, "issues"])).map_err(|err| err.to_string())?;
        if result.seeded {
            js::mkdir_all(js::path_join(&[&pool_dir, "conversations"]))
                .map_err(|err| err.to_string())?;
        }
        let merged = merge_console_config(&existing, &result.answers);
        // A relaunch whose answers all came from the file itself has nothing to write; saying "wrote"
        // then would read as a change the operator did not make.
        if js::stringify(&Value::Object(merged.clone()))
            != js::stringify(&Value::Object(existing.clone()))
        {
            write_console_config(&pool_dir, &merged)?;
            io.log(&format!(
                "wrote {}",
                js::path_join(&[&pool_dir, "console.json"])
            ));
        }
        if result.asked || !had_config {
            write_prose_files(&pool_dir, &engine_dir, io, &detection, &merged)?;
        }
        if !args.yes {
            offer_setup(io, &merged, home)?;
        }
        write_machine_defaults_once(io, home, &merged, &engine_dir);
    }
    refresh_agent_md(&pool_dir, &engine_dir, io)?;

    if args.relaunch
        && let PidRelease::Held(pid) = launch::wait_for_pid_release(
            &mut PoolLockFile::new(&pool_dir),
            launch::PID_RELEASE_TIMEOUT_MS,
        )
    {
        return Err(format!(
            "the previous server (pid {pid}) still holds {}; it did not release the pool in 15s",
            js::path_join(&[&pool_dir, "runs", "server.pid"])
        ));
    }

    start_and_report(&pool_dir, &engine_dir, &args, io)
}

fn start_and_report(
    pool_dir: &str,
    engine_dir: &str,
    args: &BootArgs,
    io: &mut dyn BootIo,
) -> Result<i32, String> {
    let runs = js::path_join(&[pool_dir, "runs"]);
    js::mkdir_all(&runs).map_err(|err| err.to_string())?;
    let log_path = js::path_join(&[&runs, "server.log"]);
    // Truncated so the boot line the poll reads is always this boot's.
    js::write_file(&log_path, "").map_err(|err| err.to_string())?;
    let program = std::env::current_exe()
        .map(|exe| js::path_text(&exe))
        .map_err(|err| err.to_string())?;
    let mut server = launch::start_server(&program, engine_dir, pool_dir, args.port, &log_path)?;
    let port = match launch::wait_for_boot(&log_path, &mut server, launch::BOOT_TIMEOUT_MS) {
        BootVerdict::Up { port } => port,
        BootVerdict::Exited { tail } => {
            io.warn("the engine refused or failed at boot; its message:");
            io.warn(if tail.is_empty() {
                "(the log is empty)"
            } else {
                &tail
            });
            return Ok(1);
        }
        BootVerdict::Timeout { tail } => {
            io.warn("the server has not printed its boot line; the log so far:");
            io.warn(if tail.is_empty() {
                "(the log is empty)"
            } else {
                &tail
            });
            return Ok(1);
        }
    };
    let url = format!("http://localhost:{}", js::number_string(port));
    if !launch::wait_for_state(&url, launch::STATE_TIMEOUT_MS) {
        io.warn(&format!(
            "{url} is up but /api/state has not answered; see {log_path}"
        ));
    }
    if args.open {
        launch::open_browser(&url);
    }
    io.log(&format!("Console on {url}"));
    io.log(&format!("log: {log_path}"));
    io.log(&format!(
        "to stop: kill $(cat {})",
        js::path_join(&[&runs, "server.pid"])
    ));
    Ok(0)
}

/// Machine defaults are written once, by the first Boot on a machine that has none, and never again
/// from here. After that the Console's Settings pane owns the file, and a Boot that rewrote it would
/// quietly promote one pool's choices over what the operator set.
fn write_machine_defaults_once(
    io: &mut dyn BootIo,
    home: &str,
    merged: &Map<String, Value>,
    engine_dir: &str,
) {
    let file = default_machine_defaults_path(home);
    if js::exists(&file) {
        return;
    }
    let defaults = merged.get("defaults").and_then(Value::as_object);
    let mut values = Map::new();
    for key in ["harness", "model", "effort", "drivers"] {
        if let Some(value) = defaults
            .and_then(|defaults| defaults.get(key))
            .filter(|value| truthy(value))
        {
            values.insert(key.to_owned(), value.clone());
        }
    }
    if merged.get("terminal").and_then(Value::as_str) == Some("herdr") {
        values.insert("terminal".to_owned(), Value::String("herdr".to_owned()));
    }
    values.insert("engine".to_owned(), Value::String(engine_dir.to_owned()));
    match write_machine_defaults(&Value::Object(values), &file) {
        Ok(_) => io.log(&format!(
            "wrote machine defaults to {file}; the Console's Settings own it from now on"
        )),
        Err(err) => io.warn(&format!("could not write {file}: {err}")),
    }
}

#[cfg(test)]
mod tests;
