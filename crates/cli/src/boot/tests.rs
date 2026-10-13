//! Boot's decisions, ported from boot-cli.test.ts where a unit test reaches them: the flags, the
//! interview, naming a new pool, the AGENT.md refresh, and the refusals that come before any write.

use std::collections::HashMap;
use std::fs;

use serde_json::{Map, Value, json};

use super::config::{CONFIG_MARKER, PortAnswer, Prefill, TerminalAnswer, merge_console_config};
use super::*;

/// A scripted operator: each question answered from the table, else with its default.
#[derive(Default)]
struct Pen {
    answers: HashMap<String, Vec<String>>,
    asked: Vec<String>,
    logs: Vec<String>,
    warned: Vec<String>,
}

impl Pen {
    fn new(answers: &[(&str, &str)]) -> Self {
        let mut pen = Pen::default();
        for (question, answer) in answers {
            pen.answers
                .entry((*question).to_owned())
                .or_default()
                .push((*answer).to_owned());
        }
        pen
    }
}

impl BootIo for Pen {
    fn ask(&mut self, question: &str, fallback: &str) -> String {
        self.asked.push(question.to_owned());
        match self.answers.get_mut(question) {
            Some(queue) if !queue.is_empty() => queue.remove(0),
            _ => fallback.to_owned(),
        }
    }
    fn log(&mut self, line: &str) {
        self.logs.push(line.to_owned());
    }
    fn warn(&mut self, line: &str) {
        self.warned.push(line.to_owned());
    }
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn temp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn text(dir: &tempfile::TempDir) -> String {
    js::path_text(dir.path())
}

// flags

#[test]
fn accepts_the_positional_pool_and_every_flag() {
    assert_eq!(
        parse_boot_args(&strings(&[
            ".scratch/x",
            "--yes",
            "--relaunch",
            "--port",
            "9001",
            "--no-open"
        ])),
        Ok(BootArgs {
            pool_dir: Some(".scratch/x".to_owned()),
            yes: true,
            relaunch: true,
            port: Some(9001),
            setup: None,
            open: false,
        })
    );
}

#[test]
fn accepts_pool_as_the_positionals_long_form() {
    let args = parse_boot_args(&strings(&[
        "--pool",
        "/pools/one",
        "--setup",
        "standard-build",
        "-y",
    ]))
    .unwrap();
    assert_eq!(args.pool_dir.as_deref(), Some("/pools/one"));
    assert_eq!(args.setup.as_deref(), Some("standard-build"));
    assert!(args.yes);
}

#[test]
fn rejects_a_flag_with_no_value_and_an_unknown_flag() {
    let refused = |argv: &[&str]| parse_boot_args(&strings(argv)).unwrap_err().message;
    assert_eq!(
        refused(&["--port"]),
        format!("--port needs a value\n{USAGE}")
    );
    assert_eq!(
        refused(&["--pool", "--yes"]),
        format!("--pool needs a value\n{USAGE}")
    );
    assert_eq!(
        refused(&["--nope"]),
        format!("unknown flag --nope\n{USAGE}")
    );
    assert_eq!(refused(&["-"]), format!("unknown flag -\n{USAGE}"));
    assert_eq!(refused(&["a", "b"]), format!("too many arguments\n{USAGE}"));
    assert_eq!(
        refused(&["--port", "abc"]),
        "--port must be a number, got abc"
    );
    assert_eq!(
        refused(&["--port", "1.5"]),
        "--port must be a number, got 1.5"
    );
    assert_eq!(
        refused(&["--port", "70000"]),
        "--port: port must be an integer 0-65535, got 70000"
    );
    assert_eq!(
        refused(&["--port", "-1"]),
        "--port: port must be an integer 0-65535, got -1"
    );
    let help = parse_boot_args(&strings(&["--yes", "--help"])).unwrap_err();
    assert!(help.help);
    assert_eq!(help.message, USAGE);
}

#[test]
fn reads_a_port_as_javascripts_number_does() {
    let port = |value: &str| parse_boot_args(&strings(&["--port", value])).unwrap().port;
    assert_eq!(port("0x10"), Some(16));
    assert_eq!(port("1e3"), Some(1000));
    assert_eq!(port(""), Some(0));
    assert_eq!(port("-0"), Some(0));
}

// the terminal's ask

#[test]
fn reads_one_line_per_question_however_the_answers_arrive() {
    let mut io = TerminalIo::new("one\r\ntwo\rthree\n\n  four  \nfive".as_bytes());
    assert_eq!(io.next_line().as_deref(), Some("one"));
    assert_eq!(io.next_line().as_deref(), Some("two"));
    assert_eq!(io.next_line().as_deref(), Some("three"));
    assert_eq!(io.next_line().as_deref(), Some(""));
    assert_eq!(io.ask("q", "d"), "four");
    assert_eq!(io.ask("q", "d"), "five");
    // Input ended: every remaining question takes its default.
    assert_eq!(io.ask("q", "d"), "d");
    assert_eq!(io.next_line(), None);
}

#[test]
fn takes_the_default_for_a_blank_answer() {
    let mut io = TerminalIo::new("   \n".as_bytes());
    assert_eq!(io.ask("q", "fallback"), "fallback");
}

// naming a new pool

#[test]
fn asks_for_the_title_first_and_derives_the_directory_from_it() {
    let root = temp();
    let scratch = js::path_join(&[&text(&root), ".scratch"]);
    let mut pen = Pen::new(&[(
        "title for the new pool (blank for none)",
        "  Jev as the grader ",
    )]);
    let named = name_new_pool(&mut pen, &scratch, "feature-x", false);
    assert_eq!(
        pen.asked,
        [
            "title for the new pool (blank for none)",
            "directory for the new pool"
        ]
    );
    assert_eq!(
        named,
        (
            Some("Jev as the grader".to_owned()),
            "jev-as-the-grader".to_owned()
        )
    );
}

#[test]
fn keeps_the_branchs_directory_and_no_title_when_the_title_is_left_blank() {
    let root = temp();
    let scratch = js::path_join(&[&text(&root), ".scratch"]);
    assert_eq!(
        name_new_pool(&mut Pen::default(), &scratch, "feature-x", false),
        (None, "feature-x".to_owned())
    );
}

#[test]
fn takes_a_directory_the_operator_types_over_the_derived_one() {
    let root = temp();
    let scratch = js::path_join(&[&text(&root), ".scratch"]);
    let mut pen = Pen::new(&[
        (
            "title for the new pool (blank for none)",
            "Jev as the grader",
        ),
        ("directory for the new pool", "Jev Pool"),
    ]);
    assert_eq!(
        name_new_pool(&mut pen, &scratch, "feature-x", false),
        (Some("Jev as the grader".to_owned()), "jev-pool".to_owned())
    );
}

#[test]
fn never_lands_a_new_pool_in_a_directory_that_is_already_there() {
    let root = temp();
    let scratch = js::path_join(&[&text(&root), ".scratch"]);
    fs::create_dir_all(js::path_join(&[&scratch, "jev-as-the-grader"])).unwrap();
    fs::create_dir_all(js::path_join(&[&scratch, "taken"])).unwrap();
    let mut pen = Pen::new(&[(
        "title for the new pool (blank for none)",
        "Jev as the grader",
    )]);
    assert_eq!(
        name_new_pool(&mut pen, &scratch, "feature-x", false).1,
        "jev-as-the-grader-2"
    );
    let mut pen = Pen::new(&[("directory for the new pool", "taken")]);
    assert_eq!(
        name_new_pool(&mut pen, &scratch, "feature-x", false).1,
        "taken-2"
    );
    assert_eq!(
        pen.warned,
        [format!("taken is already under {scratch}; using taken-2")]
    );
}

#[test]
fn asks_nothing_unattended_no_title_and_the_branchs_directory() {
    let root = temp();
    let scratch = js::path_join(&[&text(&root), ".scratch"]);
    let mut pen = Pen::default();
    assert_eq!(
        name_new_pool(&mut pen, &scratch, "feature-x", true),
        (None, "feature-x".to_owned())
    );
    assert!(pen.asked.is_empty());
}

// interview

fn detection() -> Detection {
    Detection {
        tickets: 0,
        conversations: false,
        context_files: Vec::new(),
        commit_prefix: None,
        harnesses: strings(&["claude", "opencode"]),
        herdr_binary: true,
        herdr_socket: true,
        default_port_free: true,
        engine_dir: "/engine".to_owned(),
    }
}

fn settled_everything() -> Prefill {
    Prefill {
        harness: Some("opencode".to_owned()),
        model: Some("m".to_owned()),
        effort: Some("high".to_owned()),
        drivers: Some("implement".to_owned()),
        resolver: Some(json!("opencode")),
        reviewer: Some("r".to_owned()),
        checkpoint: Some("c".to_owned()),
        port: Some(json!(9001)),
        terminal: true,
        seeded: None,
    }
}

#[test]
fn asks_the_full_interview_when_nothing_is_prefilled() {
    let mut pen = Pen::new(&[
        ("pool kind, ticket or seeded", "ticket"),
        ("default harness (claude/opencode/cursor)", "claude"),
        ("default model", "claude-opus-5"),
    ]);
    let prefill = Prefill {
        drivers: Some("implement".to_owned()),
        terminal: true,
        ..Prefill::default()
    };
    let result = interview(&mut pen, &prefill, &Prefill::default(), &detection(), false);
    assert!(!result.seeded);
    assert!(result.asked);
    assert_eq!(result.answers.harness.as_deref(), Some("claude"));
    assert_eq!(result.answers.model.as_deref(), Some("claude-opus-5"));
    assert_eq!(result.answers.drivers.as_deref(), Some("implement"));
    assert_eq!(result.answers.terminal, Some(TerminalAnswer::Herdr));
    assert_eq!(result.answers.resolver, Some(json!("claude")));
    assert_eq!(result.answers.port, None);
    assert!(result.missing.is_empty());
    assert_eq!(
        pen.asked,
        [
            "pool kind, ticket or seeded",
            "default harness (claude/opencode/cursor)",
            "default model",
            "drivers (space separated chain)",
            "merge resolver harness (or none)",
            "reviewer and its authority (blank for none)",
            "what counts as a checkpoint here",
            "port to pin (auto for 8787 or next free)",
            "terminal-backed attempts in herdr tabs (yes/no)",
        ]
    );
    assert!(
        !pen.asked
            .iter()
            .any(|question| question.contains("roster") || question.contains("agents"))
    );
}

#[test]
fn asks_nothing_for_a_field_a_prefill_already_settled() {
    let mut pen = Pen::default();
    let settled = settled_everything();
    let result = interview(
        &mut pen,
        &settled.clone(),
        &settled,
        &Detection {
            tickets: 3,
            ..detection()
        },
        false,
    );
    assert!(pen.asked.is_empty());
    assert!(!result.asked);
    assert_eq!(result.answers.port, Some(PortAnswer::Pin(json!(9001))));
    // A settled field is not asked, but it is still written: the pool carries its own config as data
    // rather than looking the machine's up every boot.
    assert_eq!(
        merge_console_config(&Map::new(), &result.answers)["defaults"],
        json!({ "harness": "opencode", "model": "m", "effort": "high", "drivers": "implement" })
    );
}

#[test]
fn names_the_fields_it_could_not_fill_when_it_may_not_ask() {
    let result = interview(
        &mut Pen::default(),
        &Prefill::default(),
        &Prefill::default(),
        &Detection {
            harnesses: Vec::new(),
            ..detection()
        },
        true,
    );
    assert_eq!(result.missing, ["harness", "model"]);
    assert!(!result.asked);
}

#[test]
fn asks_the_pool_kind_only_when_the_disk_cannot_answer_it() {
    let mut pen = Pen::default();
    let settled = Prefill {
        drivers: Some("d".to_owned()),
        port: Some(json!(1)),
        ..settled_everything()
    };
    let prefill = Prefill {
        seeded: Some(true),
        ..settled.clone()
    };
    let result = interview(
        &mut pen,
        &prefill,
        &settled,
        &Detection {
            conversations: true,
            ..detection()
        },
        false,
    );
    assert!(pen.asked.is_empty());
    assert!(result.seeded);
}

#[test]
fn asks_the_harness_again_after_one_it_has_no_descriptor_for() {
    let mut pen = Pen::new(&[
        ("default harness (claude/opencode/cursor)", "nope"),
        ("default harness (claude/opencode/cursor)", "cursor"),
    ]);
    let result = interview(
        &mut pen,
        &Prefill::default(),
        &Prefill::default(),
        &Detection {
            tickets: 1,
            ..detection()
        },
        false,
    );
    assert_eq!(result.answers.harness.as_deref(), Some("cursor"));
    assert_eq!(
        pen.warned,
        [
            "the engine has no descriptor for nope; pick one of claude, opencode, cursor",
            "cursor is not on PATH; the first attempt will fail until it is",
        ]
    );
}

#[test]
fn pins_a_typed_port_and_clears_a_pin_on_auto() {
    let mut pen = Pen::new(&[
        ("port to pin (auto for 8787 or next free)", "70000"),
        ("port to pin (auto for 8787 or next free)", "0x10"),
    ]);
    let result = interview(
        &mut pen,
        &Prefill::default(),
        &Prefill::default(),
        &Detection {
            tickets: 1,
            ..detection()
        },
        false,
    );
    assert_eq!(result.answers.port, Some(PortAnswer::Pin(json!(16))));
    assert_eq!(pen.warned, ["a port is an integer 0-65535, or auto"]);
    // An explicit auto on a pool whose prefill (not settled) has a pin removes it.
    let mut pen = Pen::new(&[("port to pin (auto for 8787 or next free)", "AUTO")]);
    let result = interview(
        &mut pen,
        &Prefill {
            port: Some(json!(9001)),
            ..Prefill::default()
        },
        &Prefill::default(),
        &Detection {
            tickets: 1,
            ..detection()
        },
        false,
    );
    assert_eq!(result.answers.port, Some(PortAnswer::Auto));
}

#[test]
fn offers_the_resolver_the_pools_resolver_harness_first() {
    let mut pen = Pen::default();
    let prefill = Prefill {
        resolver: Some(json!({ "harness": "cursor", "model": "x" })),
        harness: Some("claude".to_owned()),
        ..Prefill::default()
    };
    let result = interview(
        &mut pen,
        &prefill,
        &Prefill::default(),
        &Detection {
            tickets: 1,
            ..detection()
        },
        true,
    );
    assert_eq!(result.answers.resolver, Some(json!("cursor")));
    let result = interview(
        &mut Pen::default(),
        &Prefill::default(),
        &Prefill::default(),
        &Detection {
            tickets: 1,
            harnesses: Vec::new(),
            ..detection()
        },
        true,
    );
    assert_eq!(result.answers.resolver, Some(json!("none")));
}

// AGENT.md refresh

const OLD_HEAD: &str = "# Runner agent instructions\n\n## Your role\n\nYou are an **orchestrator**. Delegate to the subagents in your roster.\n\n";
const NEW_HEAD: &str = "# Runner agent instructions\n\n## Your job\n\nYou work one ticket.\n";
const POOL_HALF: &str =
    "\n\n## Read before you touch anything  \r\n- `SPEC.md`: the spec, café\n\n## Notes";

struct Rig {
    pool: tempfile::TempDir,
    engine: tempfile::TempDir,
}

fn rig(agent_md: Option<&str>) -> Rig {
    let pool = temp();
    let engine = temp();
    let templates = engine.path().join("skills/my-console-runner");
    fs::create_dir_all(&templates).unwrap();
    fs::write(
        templates.join("AGENT.template.md"),
        format!("{NEW_HEAD}{CONFIG_MARKER}\n\nAuthor everything below.\n"),
    )
    .unwrap();
    if let Some(text) = agent_md {
        fs::write(pool.path().join("AGENT.md"), text).unwrap();
    }
    Rig { pool, engine }
}

#[test]
fn rewrites_the_pools_agent_md_on_boot_and_says_so() {
    let r = rig(Some(&format!("{OLD_HEAD}{CONFIG_MARKER}{POOL_HALF}")));
    let mut pen = Pen::default();
    refresh_agent_md(&text(&r.pool), &text(&r.engine), &mut pen).unwrap();
    assert_eq!(
        fs::read_to_string(r.pool.path().join("AGENT.md")).unwrap(),
        format!("{NEW_HEAD}{CONFIG_MARKER}{POOL_HALF}")
    );
    assert_eq!(
        pen.logs,
        ["refreshed AGENT.md above the CONFIG marker from the template"]
    );
    // A second Boot finds it current and says nothing.
    let mut pen = Pen::default();
    refresh_agent_md(&text(&r.pool), &text(&r.engine), &mut pen).unwrap();
    assert!(pen.logs.is_empty());
}

#[test]
fn leaves_an_agent_md_with_no_marker_exactly_as_it_was() {
    let hand_written = "# Our own instructions\n\nYou are an orchestrator.\n";
    let r = rig(Some(hand_written));
    let mut pen = Pen::default();
    refresh_agent_md(&text(&r.pool), &text(&r.engine), &mut pen).unwrap();
    assert_eq!(
        fs::read_to_string(r.pool.path().join("AGENT.md")).unwrap(),
        hand_written
    );
    assert_eq!(pen.logs, ["AGENT.md has no CONFIG marker; left as it is"]);
}

#[test]
fn creates_nothing_when_the_pool_has_no_agent_md() {
    let r = rig(None);
    let mut pen = Pen::default();
    refresh_agent_md(&text(&r.pool), &text(&r.engine), &mut pen).unwrap();
    assert!(!r.pool.path().join("AGENT.md").exists());
    assert!(pen.logs.is_empty());
}

#[test]
fn ships_a_template_whose_engine_half_prescribes_no_method() {
    let template = engine_checkout(None);
    let real =
        fs::read_to_string(Path::new(&template).join("skills/my-console-runner/AGENT.template.md"))
            .unwrap();
    let marker = real.find(CONFIG_MARKER).unwrap();
    assert!(marker > 0);
    let head = real[..marker].to_lowercase();
    for word in ["orchestrat", "subagent", "delegat", "roster", "dispatch"] {
        assert!(!head.contains(word), "{word}");
    }
}

#[test]
fn takes_the_machines_engine_only_when_it_is_there() {
    let dir = temp();
    assert_eq!(engine_checkout(Some(&text(&dir))), text(&dir));
    let built = engine_checkout(None);
    assert_eq!(engine_checkout(Some("/no/such/engine")), built);
    assert_eq!(engine_checkout(Some("")), built);
    assert!(Path::new(&built).join("crates/cli/Cargo.toml").exists());
}

// prose files and Machine defaults

#[test]
fn writes_agent_md_and_verify_md_from_the_templates_once() {
    let r = rig(None);
    fs::write(
        r.engine
            .path()
            .join("skills/my-console-runner/verify.template.md"),
        "# verify\n",
    )
    .unwrap();
    let merged = Map::from_iter([
        ("reviewer".to_owned(), json!("r")),
        ("checkpoint".to_owned(), json!("")),
    ]);
    let detection = Detection {
        context_files: strings(&["SPEC.md"]),
        commit_prefix: Some("feat".to_owned()),
        ..detection()
    };
    let mut pen = Pen::default();
    write_prose_files(
        &text(&r.pool),
        &text(&r.engine),
        &mut pen,
        &detection,
        &merged,
    )
    .unwrap();
    assert_eq!(
        pen.logs,
        [
            "wrote AGENT.md from the template",
            "wrote verify.md from the template"
        ]
    );
    let agent = fs::read_to_string(r.pool.path().join("AGENT.md")).unwrap();
    assert!(agent.contains("- `SPEC.md`: (what it is for)"));
    assert!(agent.contains("- reviewer: r\n\n## Which"));
    assert_eq!(
        fs::read_to_string(r.pool.path().join("verify.md")).unwrap(),
        "# verify\n"
    );
    let mut pen = Pen::default();
    write_prose_files(
        &text(&r.pool),
        &text(&r.engine),
        &mut pen,
        &detection,
        &merged,
    )
    .unwrap();
    assert_eq!(pen.logs, ["verify.md is already there; left as it is"]);

    let bare = temp();
    let mut pen = Pen::default();
    write_prose_files(&text(&bare), &text(&r.pool), &mut pen, &detection, &merged).unwrap();
    assert_eq!(
        pen.warned,
        [format!(
            "no AGENT.template.md under {}/skills/my-console-runner; wrote no AGENT.md",
            text(&r.pool)
        )]
    );
}

#[test]
fn writes_machine_defaults_once_from_the_first_pool() {
    let home = temp();
    let merged = match json!({
        "defaults": { "harness": "claude", "model": "m", "effort": "", "drivers": "implement" },
        "terminal": "herdr",
    }) {
        Value::Object(map) => map,
        _ => unreachable!(),
    };
    let mut pen = Pen::default();
    write_machine_defaults_once(&mut pen, &text(&home), &merged, "/engine");
    let file = format!("{}/.agent-graphs/defaults.json", text(&home));
    assert_eq!(
        pen.logs,
        [format!(
            "wrote machine defaults to {file}; the Console's Settings own it from now on"
        )]
    );
    let written: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(
        written,
        json!({ "harness": "claude", "model": "m", "drivers": "implement", "engine": "/engine", "terminal": "herdr" })
    );
    let before = fs::read(&file).unwrap();
    let mut pen = Pen::default();
    write_machine_defaults_once(&mut pen, &text(&home), &Map::new(), "/other");
    assert!(pen.logs.is_empty());
    assert_eq!(fs::read(&file).unwrap(), before);
}

// refusals before any write

#[test]
fn refuses_a_config_that_does_not_parse_before_writing_anything() {
    let pool = temp();
    let home = temp();
    fs::write(pool.path().join("console.json"), "[]").unwrap();
    let mut pen = Pen::default();
    let refused = run_boot(&strings(&[&text(&pool), "--yes"]), &mut pen, &text(&home));
    assert_eq!(
        refused,
        Err(format!(
            "{}/console.json must be a JSON object",
            text(&pool)
        ))
    );
    assert_eq!(
        pen.logs,
        [format!("pool: {} (named on the command line)", text(&pool))]
    );
    assert_eq!(
        fs::read_to_string(pool.path().join("console.json")).unwrap(),
        "[]"
    );
}

#[test]
fn names_the_fields_nothing_prefilled_unattended_and_writes_nothing() {
    let pool = temp();
    let home = temp();
    fs::create_dir(pool.path().join("conversations")).unwrap();
    let mut pen = Pen::default();
    let refused = run_boot(&strings(&[&text(&pool), "--yes"]), &mut pen, &text(&home)).unwrap_err();
    // Whether the harness is missing too depends on what this machine has on PATH.
    assert!(refused.starts_with("nothing prefilled the "), "{refused}");
    assert!(
        refused.ends_with(
            "model; set it in ~/.agent-graphs/defaults.json, pass --setup, or boot without --yes"
        ),
        "{refused}"
    );
    assert!(!pool.path().join("console.json").exists());
    assert!(!pool.path().join("issues").exists());
}

#[test]
fn refuses_a_setup_it_cannot_find() {
    let pool = temp();
    let home = temp();
    let mut pen = Pen::default();
    let refused = run_boot(
        &strings(&[&text(&pool), "--setup", "nothing", "--yes"]),
        &mut pen,
        &text(&home),
    );
    assert_eq!(
        refused,
        Err("no Setup named nothing under ~/.agent-graphs/setups/".to_owned())
    );
}

#[test]
fn prints_the_usage_on_help_and_starts_nothing() {
    let mut pen = Pen::default();
    assert_eq!(run_boot(&strings(&["--help"]), &mut pen, "/nowhere"), Ok(0));
    assert_eq!(pen.logs, [USAGE]);
    let mut pen = Pen::default();
    assert_eq!(
        run_boot(&strings(&["--nope"]), &mut pen, "/nowhere"),
        Err(format!("unknown flag --nope\n{USAGE}"))
    );
}
