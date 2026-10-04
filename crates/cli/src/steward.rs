//! The Steward's command (ADR-0030; steward-cli.ts): a thin command line over the pool server's
//! `/api/steward/` routes, which is how a Steward answers on the operator's path from inside its pane.
//! Its teaching names the exact invocation:
//!
//! ```text
//! agent-console steward --pool <pool-dir> [--url <console-url>] --as <conversation> <verb> ...
//! ```
//!
//! A note, message or closing line given as `-` is read from standard input. The Console is reached at
//! `--url` when it answers there, and otherwise found again by pool directory in the fleet registry,
//! since a Restart may have moved its port. Every route checks the conversation id against the live
//! Steward; the engine holds every rule, and this command only carries words.

use std::io::{Read, Write};

use ac_core::fleet::{default_registry_path, read_fleet_entries};
use ac_core::js;
use serde_json::{Map, Value};

/// The usage. Its first line names this binary's command; the verb lines are steward-cli.ts's.
pub const STEWARD_USAGE: &str = "usage: agent-console steward --pool <pool-dir> [--url <console-url>] --as <conversation> <verb> ...
  answer <ticket> resume|approve|reject [note]
  close <ticket> <note>   (only while the pool lets the Steward Close)
  keep-talking <ticket> <message>
  leave <ticket> <note>
  held adopt|discard <proposal-id>
  reassign <ticket> field=value...   (harness, model, effort, drivers, verify; field= clears)
  state
  end [closing line]
A note, message or closing line of \"-\" is read from standard input.";

/// The options (anywhere on the line) and the verb with its words.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StewardArgs {
    pub pool: Option<String>,
    pub url: Option<String>,
    pub conversation: Option<String>,
    pub registry: Option<String>,
    pub verb: Option<String>,
    pub rest: Vec<String>,
}

/// Read the options wherever they sit; every other word is the verb's.
pub fn parse_steward_args(argv: &[String]) -> StewardArgs {
    let mut out = StewardArgs::default();
    let mut words: Vec<String> = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        let slot = match argv[i].as_str() {
            "--pool" => Some(&mut out.pool),
            "--url" => Some(&mut out.url),
            "--as" => Some(&mut out.conversation),
            "--registry" => Some(&mut out.registry),
            _ => None,
        };
        match slot {
            Some(slot) if i + 1 < argv.len() => {
                *slot = Some(argv[i + 1].clone());
                i += 2;
            }
            _ => {
                words.push(argv[i].clone());
                i += 1;
            }
        }
    }
    let mut words = words.into_iter();
    out.verb = words.next();
    out.rest = words.collect();
    out
}

/// One HTTP call the command makes.
#[derive(Debug, Clone, PartialEq)]
pub enum StewardCall {
    Get {
        path: String,
    },
    Post {
        path: String,
        body: Map<String, Value>,
    },
}

impl StewardCall {
    fn path(&self) -> &str {
        match self {
            StewardCall::Get { path } | StewardCall::Post { path, .. } => path,
        }
    }
}

/// A verb line the command cannot send, and what is missing from it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageError(pub String);

// The free text after the verb's fixed words: joined with spaces, so an agent need not quote it, or
// read whole from standard input for "-".
fn free_text(words: &[String], stdin: &mut dyn FnMut() -> String) -> String {
    if words.len() == 1 && words[0] == "-" {
        return js::trim(&stdin()).to_owned();
    }
    js::trim(&words.join(" ")).to_owned()
}

fn word(words: &[String], index: usize) -> Option<&str> {
    words
        .get(index)
        .map(String::as_str)
        .filter(|word| !word.is_empty())
}

fn text_value(text: impl Into<String>) -> Value {
    Value::String(text.into())
}

/// The call one verb makes, or a [`UsageError`] naming what is missing.
pub fn steward_call(
    conversation: &str,
    verb: &str,
    words: &[String],
    stdin: &mut dyn FnMut() -> String,
) -> Result<StewardCall, UsageError> {
    let post = |path: &str, fields: Vec<(&str, Value)>| {
        let mut body = Map::new();
        body.insert("conversation".to_owned(), text_value(conversation));
        for (key, value) in fields {
            body.insert(key.to_owned(), value);
        }
        StewardCall::Post {
            path: path.to_owned(),
            body,
        }
    };
    let usage = |text: &str| UsageError(text.to_owned());
    match verb {
        "answer" => {
            let ticket = word(words, 0);
            let action = words.get(1).map(String::as_str);
            let (Some(ticket), Some(action @ ("resume" | "approve" | "reject"))) = (ticket, action)
            else {
                return Err(usage("answer <ticket> resume|approve|reject [note]"));
            };
            let text = free_text(words.get(2..).unwrap_or_default(), stdin);
            let mut fields = vec![
                ("ticketId", text_value(ticket)),
                ("action", text_value(action)),
            ];
            if !text.is_empty() {
                fields.push(("note", text_value(text)));
            }
            Ok(post("/api/steward/answer", fields))
        }
        // Close is its own verb, not an answer action, so the teaching can list it only while the pool
        // allows it. The engine holds that rule.
        "close" => {
            let text = free_text(words.get(1..).unwrap_or_default(), stdin);
            match word(words, 0) {
                Some(ticket) if !text.is_empty() => Ok(post(
                    "/api/steward/answer",
                    vec![
                        ("ticketId", text_value(ticket)),
                        ("action", text_value("close")),
                        ("note", text_value(text)),
                    ],
                )),
                _ => Err(usage("close <ticket> <note>")),
            }
        }
        "keep-talking" => {
            let text = free_text(words.get(1..).unwrap_or_default(), stdin);
            match word(words, 0) {
                Some(ticket) if !text.is_empty() => Ok(post(
                    "/api/steward/keep-talking",
                    vec![
                        ("ticketId", text_value(ticket)),
                        ("message", text_value(text)),
                    ],
                )),
                _ => Err(usage("keep-talking <ticket> <message>")),
            }
        }
        "leave" => {
            let text = free_text(words.get(1..).unwrap_or_default(), stdin);
            match word(words, 0) {
                Some(ticket) if !text.is_empty() => Ok(post(
                    "/api/steward/leave",
                    vec![("ticketId", text_value(ticket)), ("note", text_value(text))],
                )),
                _ => Err(usage("leave <ticket> <note>")),
            }
        }
        "held" => match (words.first().map(String::as_str), word(words, 1)) {
            (Some(action @ ("adopt" | "discard")), Some(id)) => Ok(post(
                "/api/steward/held",
                vec![("action", text_value(action)), ("id", text_value(id))],
            )),
            _ => Err(usage("held adopt|discard <proposal-id>")),
        },
        "reassign" => {
            let pairs = words.get(1..).unwrap_or_default();
            let Some(ticket) = word(words, 0).filter(|_| !pairs.is_empty()) else {
                return Err(usage("reassign <ticket> field=value..."));
            };
            let mut fields = Map::new();
            for pair in pairs {
                let Some(eq) = pair.find('=').filter(|eq| *eq > 0) else {
                    return Err(UsageError(format!("reassign: '{pair}' is not field=value")));
                };
                let field = &pair[..eq];
                let value = js::trim(&pair[eq + 1..]);
                let value = if field == "verify" {
                    if value.is_empty() {
                        Value::Null
                    } else {
                        // NaN would reach the route as null and clear verify instead.
                        let count = js::number_from_text(value);
                        if !count.is_finite() || count.fract() != 0.0 {
                            return Err(UsageError(format!(
                                "reassign: verify={value} is not a whole number"
                            )));
                        }
                        js::number_value(count)
                    }
                } else if value.is_empty() {
                    Value::Null
                } else {
                    text_value(value)
                };
                fields.insert(field.to_owned(), value);
            }
            Ok(post(
                "/api/steward/reassign",
                vec![
                    ("tickets", Value::Array(vec![text_value(ticket)])),
                    ("fields", Value::Object(fields)),
                ],
            ))
        }
        "state" => Ok(StewardCall::Get {
            path: format!(
                "/api/steward/state?conversation={}",
                js::encode_uri_component(conversation)
            ),
        }),
        "end" => {
            let text = free_text(words, stdin);
            let fields = if text.is_empty() {
                Vec::new()
            } else {
                vec![("closing", text_value(text))]
            };
            Ok(post("/api/steward/end", fields))
        }
        _ => Err(UsageError(format!("unknown verb '{verb}'"))),
    }
}

// Whether two spellings name one directory.
fn same_dir(a: &str, b: &str) -> bool {
    let canonical = |dir: &str| match js::realpath(dir) {
        Ok(real) => js::path_text(&real),
        Err(_) => js::path_resolve(dir),
    };
    canonical(a) == canonical(b)
}

/// Where the Console may answer, in the order to try: `--url`, then the pool's fleet entry.
pub fn steward_console_urls(url: Option<&str>, pool: Option<&str>, registry: &str) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    if let Some(url) = url.filter(|url| !url.is_empty()) {
        urls.push(url.trim_end_matches('/').to_owned());
    }
    if let Some(pool) = pool.filter(|pool| !pool.is_empty())
        && let Some(entry) = read_fleet_entries(registry)
            .into_iter()
            .find(|entry| same_dir(&entry.pool_dir, pool))
    {
        let found = format!("http://localhost:{}", entry.port_text());
        if !urls.contains(&found) {
            urls.push(found);
        }
    }
    urls
}

// A field as a template literal prints it: `undefined` when it is not there.
fn printed(value: &Value, key: &str) -> String {
    value
        .get(key)
        .map_or_else(|| "undefined".to_owned(), js::string_of)
}

fn truthy(value: &Value, key: &str) -> bool {
    match value.get(key) {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

fn items<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// The state read, compact: one line per pending Interrupt, then the queue and the spawns.
pub fn format_steward_state(state: &Value) -> String {
    let mut lines = vec![format!(
        "Steward {}; budget {} per Ticket; Close {}; pool {}.",
        printed(state, "steward"),
        printed(state, "budget"),
        if truthy(state, "mayClose") {
            "allowed (checkpoint and merge-conflict, with a note)"
        } else {
            "off (the operator's)"
        },
        printed(state, "phase"),
    )];
    let interrupts = items(state, "interrupts");
    lines.push(
        if interrupts.is_empty() {
            "Interrupts: none pending."
        } else {
            "Interrupts:"
        }
        .to_owned(),
    );
    for interrupt in interrupts {
        let title = if truthy(interrupt, "title") {
            format!(" \"{}\"", printed(interrupt, "title"))
        } else {
            String::new()
        };
        let answerable = truthy(interrupt, "answerable");
        let mut flags: Vec<String> = Vec::new();
        if !answerable {
            flags.push("not yours".to_owned());
        }
        if truthy(interrupt, "queued") {
            flags.push("answer queued".to_owned());
        }
        if truthy(interrupt, "keepTalking") {
            flags.push("pane alive".to_owned());
        }
        if answerable {
            flags.push(format!(
                "budget {} of {} left",
                printed(interrupt, "remaining"),
                printed(state, "budget")
            ));
        }
        lines.push(format!(
            "  {}{title}: {} ({})",
            printed(interrupt, "ticketId"),
            printed(interrupt, "kind"),
            flags.join(", ")
        ));
        if truthy(interrupt, "note") {
            lines.push(format!("    your note: {}", printed(interrupt, "note")));
        }
    }
    let joined = |key: &str, separator: &str, line: fn(&Value) -> String| {
        items(state, key)
            .iter()
            .map(line)
            .collect::<Vec<_>>()
            .join(separator)
    };
    lines.push(if items(state, "mergeQueue").is_empty() {
        "Merge queue: empty.".to_owned()
    } else {
        format!(
            "Merge queue: {}.",
            joined("mergeQueue", ", ", |entry| format!(
                "{} {}",
                printed(entry, "ticketId"),
                printed(entry, "state")
            ))
        )
    });
    lines.push(if items(state, "pendingSpawns").is_empty() {
        "Pending spawns: none.".to_owned()
    } else {
        format!(
            "Pending spawns: {}.",
            joined("pendingSpawns", "; ", |spawn| format!(
                "{} ({}) \"{}\"",
                printed(spawn, "id"),
                printed(spawn, "parentId"),
                printed(spawn, "title")
            ))
        )
    });
    lines.push(if items(state, "heldSpawns").is_empty() {
        "Held spawns: none.".to_owned()
    } else {
        format!(
            "Held spawns: {}.",
            joined("heldSpawns", "; ", |spawn| format!(
                "{} ({}, {}) \"{}\"",
                printed(spawn, "id"),
                printed(spawn, "parentId"),
                printed(spawn, "reason"),
                printed(spawn, "title")
            ))
        )
    });
    lines.push(format!("Spawn ledger: {}", printed(state, "ledger")));
    lines.join("\n")
}

/// What one try at the Console came back with.
enum Reply {
    /// Nothing answered there; the reason, as a fetch would word it.
    Unreachable(String),
    Answered {
        ok: bool,
        status: u16,
        body: String,
    },
}

// How Bun's fetch words the failures a Steward meets: nothing listening, and a URL it cannot use.
fn fetch_error_text(err: &reqwest::Error) -> String {
    if err.is_connect() {
        "Unable to connect. Is the computer able to access the url?".to_owned()
    } else if err.is_builder() {
        "fetch() URL is invalid".to_owned()
    } else {
        err.to_string()
    }
}

async fn try_console(client: &reqwest::Client, base: &str, call: &StewardCall) -> Reply {
    let url = format!("{base}{}", call.path());
    let request = match call {
        StewardCall::Get { .. } => client.get(&url),
        StewardCall::Post { body, .. } => client
            .post(&url)
            .header("content-type", "application/json")
            .body(js::stringify(&Value::Object(body.clone()))),
    };
    match request.send().await {
        Err(err) => Reply::Unreachable(fetch_error_text(&err)),
        Ok(response) => {
            let status = response.status();
            Reply::Answered {
                ok: status.is_success(),
                status: status.as_u16(),
                body: response.text().await.unwrap_or_default(),
            }
        }
    }
}

/// Run the command; answers the exit code, printing through `out` and `err`.
pub fn run_steward_cli(
    argv: &[String],
    out: &mut dyn FnMut(&str),
    err: &mut dyn FnMut(&str),
    stdin: &mut dyn FnMut() -> String,
    home: &str,
) -> i32 {
    let args = parse_steward_args(argv);
    let filled = |value: &Option<String>| value.as_deref().is_some_and(|value| !value.is_empty());
    let (Some(conversation), Some(verb)) = (
        args.conversation
            .as_deref()
            .filter(|_| filled(&args.conversation)),
        args.verb.as_deref().filter(|_| filled(&args.verb)),
    ) else {
        err(STEWARD_USAGE);
        return 2;
    };
    if !filled(&args.pool) && !filled(&args.url) {
        err(STEWARD_USAGE);
        return 2;
    }
    let call = match steward_call(conversation, verb, &args.rest, stdin) {
        Ok(call) => call,
        Err(UsageError(message)) => {
            err(&format!("steward: {message}\n{STEWARD_USAGE}"));
            return 2;
        }
    };
    let registry = args
        .registry
        .clone()
        .unwrap_or_else(|| default_registry_path(home));
    let urls = steward_console_urls(args.url.as_deref(), args.pool.as_deref(), &registry);
    if urls.is_empty() {
        err(&format!(
            "steward: no live Console found for pool {}",
            args.pool.as_deref().unwrap_or("null")
        ));
        return 1;
    }
    let replies = crate::boot::on_own_runtime(async {
        let client = match reqwest::Client::builder().no_proxy().build() {
            Ok(client) => client,
            Err(build) => return vec![Reply::Unreachable(build.to_string())],
        };
        let mut replies = Vec::new();
        for base in &urls {
            let reply = try_console(&client, base, &call).await;
            let answered = matches!(reply, Reply::Answered { .. });
            replies.push(reply);
            if answered {
                break;
            }
        }
        replies
    })
    .unwrap_or_default();
    let mut last_error = String::new();
    for (base, reply) in urls.iter().zip(replies) {
        match reply {
            Reply::Unreachable(reason) => last_error = format!("{base}: {reason}"),
            Reply::Answered { ok, status, body } => {
                let payload = match js::parse(&body) {
                    Ok(value @ Value::Object(_)) => value,
                    _ => Value::Object(Map::new()),
                };
                let present = |key: &str| payload.get(key).filter(|value| !value.is_null());
                if !ok {
                    // The engine's reason is printed as it gave it: it already names its subject
                    // ("steward: ...", "reassign: ...").
                    err(&present("reason")
                        .or_else(|| present("error"))
                        .map_or_else(|| format!("steward: HTTP {status}"), js::string_of));
                    return 1;
                }
                if verb == "state" {
                    out(&format_steward_state(&payload));
                } else {
                    out(&present("message").map_or_else(|| "done".to_owned(), js::string_of));
                }
                return 0;
            }
        }
    }
    err(&format!(
        "steward: the Console did not answer ({last_error})"
    ));
    1
}

/// `agent-console steward ...`: the command as a Steward runs it.
pub fn run(args: Vec<String>) -> i32 {
    let mut out = |line: &str| {
        let _ = writeln!(std::io::stdout(), "{line}");
    };
    let mut err = |line: &str| {
        let _ = writeln!(std::io::stderr(), "{line}");
    };
    let mut stdin = || {
        let mut bytes = Vec::new();
        let _ = std::io::stdin().read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).into_owned()
    };
    run_steward_cli(
        &args,
        &mut out,
        &mut err,
        &mut stdin,
        &crate::boot::home_dir(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    fn call(verb: &str, words: &[&str]) -> Result<StewardCall, UsageError> {
        steward_call("conv-1", verb, &strings(words), &mut || {
            "  from stdin \n".to_owned()
        })
    }

    fn post(path: &str, body: Value) -> StewardCall {
        let Value::Object(body) = body else {
            unreachable!()
        };
        StewardCall::Post {
            path: path.to_owned(),
            body,
        }
    }

    #[test]
    fn takes_options_anywhere_on_the_line() {
        let args = parse_steward_args(&strings(&[
            "--pool", "/p", "answer", "01", "resume", "use", "plan", "B", "--as", "conv-1",
        ]));
        assert_eq!(
            args,
            StewardArgs {
                pool: Some("/p".to_owned()),
                url: None,
                conversation: Some("conv-1".to_owned()),
                registry: None,
                verb: Some("answer".to_owned()),
                rest: strings(&["01", "resume", "use", "plan", "B"]),
            }
        );
        // An option with nothing after it is a word.
        assert_eq!(
            parse_steward_args(&strings(&["state", "--as"])).rest,
            ["--as"]
        );
    }

    #[test]
    fn maps_each_verb_onto_its_route_taking_a_note_from_stdin() {
        assert_eq!(
            call("answer", &["01", "resume", "use", "plan", "B"]),
            Ok(post(
                "/api/steward/answer",
                json!({ "conversation": "conv-1", "ticketId": "01", "action": "resume", "note": "use plan B" })
            ))
        );
        assert_eq!(
            call("answer", &["01", "approve"]),
            Ok(post(
                "/api/steward/answer",
                json!({ "conversation": "conv-1", "ticketId": "01", "action": "approve" })
            ))
        );
        assert_eq!(
            call("leave", &["01", "-"]),
            Ok(post(
                "/api/steward/leave",
                json!({ "conversation": "conv-1", "ticketId": "01", "note": "from stdin" })
            ))
        );
        assert_eq!(
            call("keep-talking", &["01", "try", "again"]),
            Ok(post(
                "/api/steward/keep-talking",
                json!({ "conversation": "conv-1", "ticketId": "01", "message": "try again" })
            ))
        );
        assert_eq!(
            call("held", &["adopt", "proposal-2"]),
            Ok(post(
                "/api/steward/held",
                json!({ "conversation": "conv-1", "action": "adopt", "id": "proposal-2" })
            ))
        );
        let reassign = call("reassign", &["01", "model=big", "effort=", "verify=2"]).unwrap();
        assert_eq!(
            reassign,
            post(
                "/api/steward/reassign",
                json!({ "conversation": "conv-1", "tickets": ["01"], "fields": { "model": "big", "effort": null, "verify": 2 } })
            )
        );
        let StewardCall::Post { body, .. } = reassign else {
            unreachable!()
        };
        assert_eq!(
            js::stringify(&Value::Object(body)),
            r#"{"conversation":"conv-1","tickets":["01"],"fields":{"model":"big","effort":null,"verify":2}}"#
        );
        assert_eq!(
            call("state", &[]),
            Ok(StewardCall::Get {
                path: "/api/steward/state?conversation=conv-1".to_owned()
            })
        );
        assert_eq!(
            call("end", &["all", "done"]),
            Ok(post(
                "/api/steward/end",
                json!({ "conversation": "conv-1", "closing": "all done" })
            ))
        );
        assert_eq!(
            call("end", &[]),
            Ok(post(
                "/api/steward/end",
                json!({ "conversation": "conv-1" })
            ))
        );
        assert_eq!(
            call("close", &["01", "superseded", "by", "02"]),
            Ok(post(
                "/api/steward/answer",
                json!({ "conversation": "conv-1", "ticketId": "01", "action": "close", "note": "superseded by 02" })
            ))
        );
        assert_eq!(
            call("close", &["01", "-"]),
            Ok(post(
                "/api/steward/answer",
                json!({ "conversation": "conv-1", "ticketId": "01", "action": "close", "note": "from stdin" })
            ))
        );
    }

    #[test]
    fn refuses_a_verb_line_it_cannot_send() {
        let refused = |verb: &str, words: &[&str]| call(verb, words).unwrap_err().0;
        assert_eq!(
            refused("reassign", &["01", "verify=abc"]),
            "reassign: verify=abc is not a whole number"
        );
        assert_eq!(
            refused("reassign", &["01", "model"]),
            "reassign: 'model' is not field=value"
        );
        assert_eq!(
            refused("reassign", &["01", "=x"]),
            "reassign: '=x' is not field=value"
        );
        assert_eq!(
            refused("reassign", &["01"]),
            "reassign <ticket> field=value..."
        );
        // Adopt is the operator's (ADR-0035): the command has no word for it.
        for words in [
            &["01", "adopt", "2"][..],
            &["01", "close", "x"],
            &["01", "maybe"],
            &["01"],
        ] {
            assert_eq!(
                refused("answer", words),
                "answer <ticket> resume|approve|reject [note]"
            );
        }
        // A close always says why.
        assert_eq!(refused("close", &["01"]), "close <ticket> <note>");
        assert_eq!(
            refused("held", &["keep", "x"]),
            "held adopt|discard <proposal-id>"
        );
        assert_eq!(refused("leave", &["01"]), "leave <ticket> <note>");
        assert_eq!(
            refused("keep-talking", &["01"]),
            "keep-talking <ticket> <message>"
        );
        assert_eq!(refused("dance", &[]), "unknown verb 'dance'");
    }

    #[test]
    fn encodes_the_conversation_in_the_state_read() {
        assert_eq!(
            steward_call("conv 1/x", "state", &[], &mut String::new),
            Ok(StewardCall::Get {
                path: "/api/steward/state?conversation=conv%201%2Fx".to_owned()
            })
        );
    }

    #[test]
    fn formats_the_state_read_one_line_per_interrupt() {
        let state = json!({
            "steward": "conv-1",
            "budget": 5,
            "mayClose": false,
            "phase": "running",
            "interrupts": [
                { "ticketId": "01", "title": "First", "kind": "checkpoint", "answerable": true, "keepTalking": true,
                  "queued": false, "note": "waiting on the operator", "used": 1, "remaining": 4 },
                { "ticketId": "02", "title": null, "kind": "review", "answerable": false, "keepTalking": false,
                  "queued": true, "note": null, "used": 0, "remaining": 5 },
            ],
            "mergeQueue": [{ "ticketId": "03", "state": "merging" }],
            "pendingSpawns": [{ "id": "proposal-1", "parentId": "01", "title": "Follow up" }],
            "heldSpawns": [{ "id": "proposal-2", "parentId": "02", "title": "Held one", "reason": "cap" }],
            "ledger": "/p/runs/spawn-ledger.md",
        });
        assert_eq!(
            format_steward_state(&state),
            [
                "Steward conv-1; budget 5 per Ticket; Close off (the operator's); pool running.",
                "Interrupts:",
                "  01 \"First\": checkpoint (pane alive, budget 4 of 5 left)",
                "    your note: waiting on the operator",
                "  02: review (not yours, answer queued)",
                "Merge queue: 03 merging.",
                "Pending spawns: proposal-1 (01) \"Follow up\".",
                "Held spawns: proposal-2 (02, cap) \"Held one\".",
                "Spawn ledger: /p/runs/spawn-ledger.md",
            ]
            .join("\n")
        );
        let quiet = json!({
            "steward": "conv-2", "budget": 3, "mayClose": true, "phase": "done", "interrupts": [],
            "mergeQueue": [], "pendingSpawns": [], "heldSpawns": [], "ledger": "/l",
        });
        assert_eq!(
            format_steward_state(&quiet),
            [
                "Steward conv-2; budget 3 per Ticket; Close allowed (checkpoint and merge-conflict, with a note); pool done.",
                "Interrupts: none pending.",
                "Merge queue: empty.",
                "Pending spawns: none.",
                "Held spawns: none.",
                "Spawn ledger: /l",
            ]
            .join("\n")
        );
    }

    #[test]
    fn tries_the_url_first_then_the_pools_fleet_entry() {
        let dir = tempfile::tempdir().unwrap();
        let pool = js::path_text(dir.path());
        let registry = js::path_join(&[&pool, "pools.json"]);
        std::fs::write(
            &registry,
            json!([{ "poolDir": pool, "port": 9911, "pid": std::process::id(), "startedAt": "t" }])
                .to_string(),
        )
        .unwrap();
        assert_eq!(
            steward_console_urls(Some("http://localhost:1//"), Some(&pool), &registry),
            ["http://localhost:1", "http://localhost:9911"]
        );
        // The pool found by another spelling of its directory, and not listed twice.
        let spelled = format!("{pool}/./");
        assert_eq!(
            steward_console_urls(Some("http://localhost:9911"), Some(&spelled), &registry),
            ["http://localhost:9911"]
        );
        assert!(steward_console_urls(None, Some("/elsewhere"), &registry).is_empty());
    }

    #[test]
    fn refuses_a_line_with_no_conversation_verb_or_console() {
        let run = |argv: &[&str]| {
            let mut errors: Vec<String> = Vec::new();
            let code = run_steward_cli(
                &strings(argv),
                &mut |_| {},
                &mut |line| errors.push(line.to_owned()),
                &mut String::new,
                "/no/home",
            );
            (code, errors)
        };
        assert_eq!(
            run(&["--pool", "/p", "state"]),
            (2, vec![STEWARD_USAGE.to_owned()])
        );
        assert_eq!(run(&["--pool", "/p", "--as", "conv-1"]).0, 2);
        assert_eq!(run(&["--as", "conv-1", "state"]).0, 2);
        assert_eq!(
            run(&["--pool", "/p", "--as", "conv-1", "dance"]),
            (
                2,
                vec![format!("steward: unknown verb 'dance'\n{STEWARD_USAGE}")]
            )
        );
        assert_eq!(
            run(&["--pool", "/p", "--as", "conv-1", "state"]),
            (
                1,
                vec!["steward: no live Console found for pool /p".to_owned()]
            )
        );
    }
}
