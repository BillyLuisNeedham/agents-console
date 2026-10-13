//! The Evidence builder for the Jev grader (ADR-0023, docs/adr/0023-jev-grades-attempts-engine-owned-rubric.md;
//! the bench is docs/research/jev-grader-bench/REPORT.md section 2). Ported from engine/jev-evidence.ts.
//!
//! One named JSON object per Attempt: the Ticket text, the agent's summary under a field that says
//! "claim", the changed lines of the diff, and the tail of the ANSI-stripped log. Every part is
//! trimmed, because Jev's window is 32k tokens of Evidence plus the longest question and accuracy falls
//! as unrelated content grows. The function is pure: strings in, the Evidence object plus its two notes
//! out, so it tests without git or files on disk.
//!
//! The budget is enforced on the stringified object, at 100,000 characters (about 29k tokens at the
//! measured 3.5 characters per token), leaving room for the longest question. The diff is head-cut to
//! whatever the cap leaves after the other fields, never below 2,000 characters; when even that does not
//! fit (a huge Ticket), the log tail shrinks by 15% steps to a 4,000 character floor. The engine keeps
//! the raw log and full-context diff aside so the one widening re-ask (low ticket-fit confidence on
//! trimmed Evidence) can rebuild with a wider tail and the diff's context lines.
//!
//! Every length here is JavaScript's, in UTF-16 code units. A cut that lands inside a surrogate pair
//! leaves JavaScript holding the pair's lone half, which no Rust string can hold, so the text drops it;
//! the counts the notes print and the sizes the cap compares still count it as the TypeScript did (one
//! unit in the text, six in its JSON, where `JSON.stringify` writes it as `\udxxx`).

use std::sync::LazyLock;

use regex::{Regex, RegexSet};
use serde_json::Value;

use crate::jev_questions::Evidence;
use crate::js;

/// The stringified Evidence cap, before the longest question is added.
pub const EVIDENCE_CAP_CHARS: usize = 100_000;
/// The Ticket text kept, from the front: title, goal and criteria come first.
pub const TICKET_CHARS: usize = 20_000;
/// The agent summary kept, from the front.
pub const SUMMARY_CHARS: usize = 4_000;
/// The log tail kept on the base budget.
pub const LOG_TAIL_CHARS: usize = 20_000;
/// The log tail the one widening re-ask may use.
pub const LOG_WIDENED_TAIL_CHARS: usize = 80_000;
/// The diff is never cut below this many characters.
pub const DIFF_FLOOR_CHARS: usize = 2_000;
/// The floor the log shrinks to when the other fields alone fill the cap.
pub const LOG_FLOOR_CHARS: usize = 4_000;

/// What one Attempt's Evidence is built from.
#[derive(Debug, Clone, Copy, Default)]
pub struct EvidenceInput<'a> {
    /// The Ticket file text, whole.
    pub ticket: &'a str,
    /// The Outcome summary verbatim: a claim, not evidence.
    pub summary: &'a str,
    /// The Attempt diff. Empty when `diff_reason` is set (there was no diff to read); changed lines only
    /// (`git diff -U0`) on the base budget, with context lines on the widened one.
    pub diff: &'a str,
    /// Why there is no diff, when there is none, in `attemptDiff`'s wording.
    pub diff_reason: Option<&'a str>,
    /// The Attempt log, raw (ANSI escapes are stripped here).
    pub log: &'a str,
    /// True for the one widening re-ask: an 80,000-character tail.
    pub widened: bool,
}

/// One Attempt's Evidence and what was trimmed to build it.
#[derive(Debug, Clone, PartialEq)]
pub struct BuiltEvidence {
    pub evidence: Evidence,
    pub diff_note: String,
    pub log_note: String,
    /// The Evidence was trimmed: the diff cut, or the log tail shorter than the log. This is what gates
    /// the widening re-ask, never the Ticket's own cap.
    pub trimmed: bool,
    pub diff_trimmed: bool,
    pub log_trimmed: bool,
    /// The log tail the base budget would have kept, for `logWasTrimmed`.
    pub base_log_chars: usize,
}

static OSC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\][^\x07]*(?:\x07|\x1b\\)").unwrap());
static CSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap());
static SHORT_ESCAPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b[@-Z\\-_]").unwrap());

/// Strip ANSI escape sequences: OSC, CSI, and the short single-character forms.
pub fn strip_ansi(text: &str) -> String {
    let text = OSC.replace_all(text, "");
    let text = CSI.replace_all(&text, "");
    SHORT_ESCAPE.replace_all(&text, "").into_owned()
}

/// A cut of a text: what a Rust string can hold of it, and how long JavaScript's cut was.
struct Cut {
    text: String,
    /// `cut.length` in JavaScript: the text's UTF-16 units, plus one for a lone surrogate half.
    js_len: usize,
}

impl Cut {
    fn whole(text: &str) -> Cut {
        Cut {
            text: text.to_owned(),
            js_len: js::utf16_len(text),
        }
    }

    /// Whether JavaScript's cut holds a lone surrogate half this text dropped.
    fn lone(&self) -> bool {
        self.js_len != js::utf16_len(&self.text)
    }
}

/// `text.slice(0, max)`.
fn head_cut(text: &str, max: usize) -> Cut {
    let total = js::utf16_len(text);
    if total <= max {
        return Cut {
            text: text.to_owned(),
            js_len: total,
        };
    }
    Cut {
        text: js::utf16_prefix(text, max).to_owned(),
        js_len: max,
    }
}

/// `tailToLineBoundary(text, max)`, with JavaScript's length of the result.
fn tail_cut(text: &str, max: usize) -> Cut {
    let total = js::utf16_len(text);
    if total <= max {
        return Cut {
            text: text.to_owned(),
            js_len: total,
        };
    }
    // `text.slice(-max)`: from UTF-16 unit `total - max`, a pair straddling it dropped whole.
    let start = total - max;
    let mut units = 0;
    let mut at = text.len();
    for (index, c) in text.char_indices() {
        if units >= start {
            at = index;
            break;
        }
        units += c.len_utf16();
    }
    let tail = &text[at..];
    // Cut forward past the first newline unless it is the tail's last character.
    match tail.find('\n') {
        Some(newline) if newline + 1 < tail.len() => Cut::whole(&tail[newline + 1..]),
        _ => Cut {
            text: tail.to_owned(),
            js_len: max,
        },
    }
}

/// The last `max` characters, cut forward to a line boundary so the tail starts at the beginning of a
/// line. Forward, not back: an incomplete first line is dropped rather than shown torn.
pub fn tail_to_line_boundary(text: &str, max: usize) -> String {
    tail_cut(text, max).text
}

/// The file paths whose diff is pure noise to a grader: lockfiles, snapshots and generated output.
/// Dropped whole, hunk and header lines together, so a diff the grader reads is the work, not the
/// machinery around it.
static DROPPED_FILE: LazyLock<RegexSet> = LazyLock::new(|| {
    RegexSet::new([
        r"(^|/)bun\.lockb?$",
        r"(^|/)package-lock\.json$",
        r"(^|/)yarn\.lock$",
        r"(^|/)pnpm-lock\.yaml$",
        r"(^|/)Cargo\.lock$",
        r"(^|/)Gemfile\.lock$",
        r"(^|/)poetry\.lock$",
        r"(^|/)composer\.lock$",
        r"(^|/)go\.sum$",
        r"(^|/)__snapshots__/",
        r"\.snap$",
        r"\.min\.(js|css)$",
        r"\.generated\.",
        r"(^|/)node_modules/",
    ])
    .unwrap()
});

/// `/ b\/(.+)$/`: the `b/` side of a `diff --git a/<path> b/<path>` header names the file after change.
static B_SIDE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r" b/({}+)$", js::ANY_BUT_LINE_TERMINATOR)).unwrap());

fn is_dropped_diff_path(header: &str) -> bool {
    let path = B_SIDE
        .captures(header)
        .and_then(|captures| captures.get(1))
        .map_or(header, |path| path.as_str());
    DROPPED_FILE.is_match(js::trim(path))
}

/// Drop each file's diff section whose path is lockfile, snapshot or generated.
pub fn drop_generated_diffs(diff: &str) -> String {
    if diff.is_empty() {
        return String::new();
    }
    let mut kept: Vec<&str> = Vec::new();
    let mut dropping = false;
    for line in diff.split('\n') {
        if line.starts_with("diff --git ") {
            dropping = is_dropped_diff_path(line);
            if dropping {
                continue;
            }
        }
        if !dropping {
            kept.push(line);
        }
    }
    kept.join("\n")
}

fn diff_note_for(reason: Option<&str>, shown: usize, total: usize, widened: bool) -> String {
    if let Some(reason) = reason {
        return format!("no diff: {reason}");
    }
    // The note names the diff the grader actually reads: `-U0` changed lines on the base budget,
    // context lines on the widening re-ask (ADR-0023).
    let base = if widened {
        "the full diff, with context lines"
    } else {
        "changed lines only, no context lines"
    };
    if shown < total {
        return format!("{base}; the diff was cut after its first {shown} characters of {total}");
    }
    base.to_owned()
}

fn log_note_for(shown: usize, total: usize) -> String {
    if shown >= total {
        return "the whole log".to_owned();
    }
    format!("the log was trimmed to its last {shown} characters of {total}")
}

fn evidence_of(
    ticket: &str,
    summary: &str,
    diff: &str,
    diff_note: &str,
    log: &str,
    log_note: &str,
) -> Evidence {
    [
        ("ticket", ticket),
        ("agent_summary_claim", summary),
        ("diff", diff),
        ("diff_note", diff_note),
        ("log", log),
        ("log_note", log_note),
    ]
    .into_iter()
    .map(|(key, text)| (key.to_owned(), Value::from(text)))
    .collect()
}

/// `JSON.stringify({ ticket, agent_summary_claim, diff, diff_note, log, log_note }).length`.
fn serialized_size(
    ticket: &Cut,
    summary: &Cut,
    diff: &Cut,
    diff_note: &str,
    log: &Cut,
    log_note: &str,
) -> usize {
    let evidence = evidence_of(
        &ticket.text,
        &summary.text,
        &diff.text,
        diff_note,
        &log.text,
        log_note,
    );
    let lone = [ticket, summary, diff, log]
        .iter()
        .filter(|cut| cut.lone())
        .count();
    js::utf16_len(&js::stringify(&Value::Object(evidence))) + 6 * lone
}

/// Build one Attempt's Evidence under a cap. Deterministic and total: any input yields an Evidence
/// object, with the notes saying exactly what was trimmed, so the Grade can always record which budget
/// it came from.
pub fn build_evidence(input: &EvidenceInput<'_>) -> BuiltEvidence {
    let ticket = head_cut(input.ticket, TICKET_CHARS);
    let summary = head_cut(input.summary, SUMMARY_CHARS);
    let stripped = strip_ansi(input.log);
    let stripped_len = js::utf16_len(&stripped);
    let raw_diff = match input.diff_reason {
        Some(_) => String::new(),
        None => drop_generated_diffs(input.diff),
    };
    let raw_diff_len = js::utf16_len(&raw_diff);
    let widened = input.widened;

    let log_budget = if widened {
        LOG_WIDENED_TAIL_CHARS
    } else {
        LOG_TAIL_CHARS
    };
    let mut log = tail_cut(&stripped, log_budget);

    // The diff gets whatever the cap leaves after the other fields, notes included, but never less
    // than the floor. A little slack covers the note growing when the diff turns out to be cut.
    let fixed_size = serialized_size(
        &ticket,
        &summary,
        &Cut::whole(""),
        &diff_note_for(input.diff_reason, 0, raw_diff_len, widened),
        &log,
        &log_note_for(log.js_len, stripped_len),
    );
    let room = EVIDENCE_CAP_CHARS as i64 - fixed_size as i64 - 256;
    let diff_cap = room.max(DIFF_FLOOR_CHARS as i64) as usize;
    let diff = if raw_diff_len > diff_cap {
        head_cut(&raw_diff, diff_cap)
    } else {
        Cut {
            text: raw_diff,
            js_len: raw_diff_len,
        }
    };

    // Then, if the whole object still overruns (a Ticket near its own cap plus a floor diff), shrink
    // the log tail by 15% steps, never below the floor.
    for _ in 0..40 {
        let size = serialized_size(
            &ticket,
            &summary,
            &diff,
            &diff_note_for(input.diff_reason, diff.js_len, raw_diff_len, widened),
            &log,
            &log_note_for(log.js_len, stripped_len),
        );
        if size <= EVIDENCE_CAP_CHARS || log.js_len <= LOG_FLOOR_CHARS {
            break;
        }
        let next = LOG_FLOOR_CHARS.max((log.js_len as f64 * 0.85).floor() as usize);
        if next >= log.js_len {
            break;
        }
        log = tail_cut(&stripped, next);
    }

    let diff_trimmed = diff.js_len < raw_diff_len;
    let log_trimmed = log.js_len < stripped_len;
    let diff_note = diff_note_for(input.diff_reason, diff.js_len, raw_diff_len, widened);
    let log_note = log_note_for(log.js_len, stripped_len);
    BuiltEvidence {
        evidence: evidence_of(
            &ticket.text,
            &summary.text,
            &diff.text,
            &diff_note,
            &log.text,
            &log_note,
        ),
        diff_note,
        log_note,
        trimmed: diff_trimmed || log_trimmed,
        diff_trimmed,
        log_trimmed,
        base_log_chars: tail_cut(&stripped, LOG_TAIL_CHARS).js_len,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE_DIFF: &str = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n";

    fn base() -> EvidenceInput<'static> {
        EvidenceInput {
            ticket: "# ticket\n\nDo the thing.",
            summary: "I did the thing and all tests pass.",
            diff: BASE_DIFF,
            diff_reason: None,
            log: "ran the tests\nall good\n",
            widened: false,
        }
    }

    fn text<'a>(built: &'a BuiltEvidence, field: &str) -> &'a str {
        built.evidence[field].as_str().unwrap()
    }

    fn stringified_len(built: &BuiltEvidence) -> usize {
        js::utf16_len(&js::stringify(&Value::Object(built.evidence.clone())))
    }

    #[test]
    fn strip_ansi_removes_csi_colour_erase_and_osc_sequences() {
        let raw = "\u{1b}[31mred\u{1b}[0m\n\u{1b}[2Kcleared\n\u{1b}]0;title\u{7}text\n";
        assert_eq!(strip_ansi(raw), "red\ncleared\ntext\n");
        // An OSC ended by ESC \ and a short escape go too.
        assert_eq!(strip_ansi("a\u{1b}]8;;x\u{1b}\\b\u{1b}Mc"), "abc");
    }

    #[test]
    fn tail_keeps_the_whole_text_under_the_budget() {
        assert_eq!(tail_to_line_boundary("a\nb\n", 100), "a\nb\n");
    }

    #[test]
    fn tail_keeps_the_last_n_characters_cut_forward_to_a_line_start() {
        let lines: Vec<String> = (0..100)
            .map(|i| format!("line {i} {}", "x".repeat(30)))
            .collect();
        let text = lines.join("\n") + "\n";
        let tail = tail_to_line_boundary(&text, 500);
        assert!(js::utf16_len(&tail) <= 500);
        // Every line in the tail is whole: the partial first line was dropped.
        assert!(tail.starts_with("line "));
        assert!(
            tail.split('\n')
                .all(|line| line.is_empty() || line.starts_with("line "))
        );
    }

    #[test]
    fn tail_keeps_a_torn_line_when_its_only_newline_ends_the_tail() {
        assert_eq!(tail_to_line_boundary("abcdef\n", 4), "def\n");
        assert_eq!(tail_to_line_boundary("abcdef", 3), "def");
    }

    const LOCKED_DIFF: &str = "diff --git a/bun.lock b/bun.lock\n\
        --- a/bun.lock\n\
        +++ b/bun.lock\n\
        @@ -1 +1 @@\n\
        -old\n\
        +new\n\
        diff --git a/src/app.ts b/src/app.ts\n\
        --- a/src/app.ts\n\
        +++ b/src/app.ts\n\
        @@ -1 +1 @@\n\
        -before\n\
        +after\n";

    #[test]
    fn drops_lockfiles_whole_and_keeps_the_source_hunks() {
        let kept = drop_generated_diffs(LOCKED_DIFF);
        assert!(kept.contains("src/app.ts"));
        assert!(!kept.contains("bun.lock"));
        assert_eq!(
            kept,
            "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-before\n+after\n"
        );
    }

    #[test]
    fn drops_snapshot_files_and_generated_output_too() {
        let snapshots = "diff --git a/src/__snapshots__/x.snap b/src/__snapshots__/x.snap\n@@ -1 +1 @@\n-a\n+b\n\
             diff --git a/dist/bundle.min.js b/dist/bundle.min.js\n@@ -1 +1 @@\n-a\n+b\n\
             diff --git a/src/code.ts b/src/code.ts\n@@ -1 +1 @@\n-a\n+b\n";
        let kept = drop_generated_diffs(snapshots);
        assert!(kept.contains("src/code.ts"));
        assert!(!kept.contains("__snapshots__"));
        assert!(!kept.contains("bundle.min.js"));
        // Every other generated pattern, and a header with no `b/` side read whole.
        for path in [
            "package-lock.json",
            "web/yarn.lock",
            "pnpm-lock.yaml",
            "Cargo.lock",
            "Gemfile.lock",
            "poetry.lock",
            "composer.lock",
            "go.sum",
            "bun.lockb",
            "app/x.generated.ts",
            "node_modules/a/b.js",
            "s.min.css",
        ] {
            let diff = format!("diff --git a/{path} b/{path}\n+x\n");
            assert_eq!(drop_generated_diffs(&diff), "", "{path}");
        }
        // With no `b/` side the whole header is the path: a suffix pattern still matches it, a pattern
        // anchored at a path start does not.
        assert_eq!(drop_generated_diffs("diff --git x.snap\n+x\n"), "");
        assert_eq!(
            drop_generated_diffs("diff --git yarn.lock\n+x"),
            "diff --git yarn.lock\n+x"
        );
        assert_eq!(drop_generated_diffs(""), "");
    }

    #[test]
    fn names_the_claim_field_and_carries_the_ticket_summary_and_diff() {
        let built = build_evidence(&base());
        assert_eq!(text(&built, "ticket"), base().ticket);
        assert_eq!(text(&built, "agent_summary_claim"), base().summary);
        assert!(text(&built, "diff").contains("src/app.ts"));
        assert_eq!(built.diff_note, "changed lines only, no context lines");
        assert_eq!(built.log_note, "the whole log");
        assert!(!built.trimmed);
        let keys: Vec<&String> = built.evidence.keys().collect();
        assert_eq!(
            keys,
            [
                "ticket",
                "agent_summary_claim",
                "diff",
                "diff_note",
                "log",
                "log_note"
            ]
        );
    }

    #[test]
    fn strips_ansi_from_the_log_before_it_is_measured_or_sent() {
        let built = build_evidence(&EvidenceInput {
            log: "\u{1b}[31mboom\u{1b}[0m\n",
            ..base()
        });
        assert_eq!(text(&built, "log"), "boom\n");
        assert_eq!(built.log_note, "the whole log");
    }

    #[test]
    fn keeps_the_last_20000_characters_of_a_large_log_at_a_line_boundary() {
        let line = format!("{}\n", "y".repeat(49));
        let raw = format!("HEADER\n{}", line.repeat(700));
        let built = build_evidence(&EvidenceInput {
            log: &raw,
            ..base()
        });
        let log = text(&built, "log");
        assert!(js::utf16_len(log) <= 20_000);
        assert!(log.starts_with('y'));
        assert!(!log.contains("HEADER"));
        assert!(built.log_trimmed);
        assert!(built.trimmed);
        assert_eq!(
            built.log_note,
            format!(
                "the log was trimmed to its last {} characters of {}",
                js::utf16_len(log),
                js::utf16_len(&raw)
            )
        );
        assert_eq!(built.base_log_chars, js::utf16_len(log));
    }

    #[test]
    fn says_why_when_there_is_no_diff_and_treats_that_as_untrimmed() {
        let built = build_evidence(&EvidenceInput {
            diff: "",
            diff_reason: Some("no attempt branch pool/x/01.attempt-1"),
            ..base()
        });
        assert_eq!(text(&built, "diff"), "");
        assert_eq!(
            built.diff_note,
            "no diff: no attempt branch pool/x/01.attempt-1"
        );
        assert!(!built.diff_trimmed);
    }

    #[test]
    fn caps_the_stringified_evidence_at_100000_characters_and_never_cuts_the_diff_below_the_floor()
    {
        let (ticket, summary) = ("t".repeat(20_000), "s".repeat(4_000));
        let (diff, log) = ("d".repeat(300_000), "l".repeat(200_000));
        let built = build_evidence(&EvidenceInput {
            ticket: &ticket,
            summary: &summary,
            diff: &diff,
            diff_reason: None,
            // A log that cannot shrink enough to matter: the diff does the work.
            log: &log,
            widened: false,
        });
        assert!(stringified_len(&built) <= EVIDENCE_CAP_CHARS);
        assert!(js::utf16_len(text(&built, "diff")) >= DIFF_FLOOR_CHARS);
        assert!(built.diff_trimmed);
        assert!(built.diff_note.contains("the diff was cut after its first"));
        assert!(built.trimmed);
    }

    #[test]
    fn stays_under_the_cap_with_a_ticket_at_its_ceiling_and_a_huge_log() {
        // A ticket at its own 20,000 ceiling plus a base log tail: the whole object must stay under the
        // cap, and any shrink respects the 4,000 floor.
        let (ticket, summary, log) = ("t".repeat(20_000), "s".repeat(4_000), "z".repeat(300_000));
        let built = build_evidence(&EvidenceInput {
            ticket: &ticket,
            summary: &summary,
            diff: "",
            diff_reason: Some("the pool does not run in git"),
            log: &log,
            widened: false,
        });
        assert!(stringified_len(&built) <= EVIDENCE_CAP_CHARS);
        assert!(js::utf16_len(text(&built, "log")) >= LOG_FLOOR_CHARS);
        assert!(built.log_note.contains("the log was trimmed to its last"));
    }

    #[test]
    fn shrinks_the_log_by_15_percent_steps_to_its_floor_when_a_floor_diff_still_overruns() {
        // A control character takes six characters in JSON, so a Ticket of them fills the cap on its
        // own: the diff is cut to its floor and the log tail shrinks from 20,000 in 15% steps to 4,000.
        let ticket = "\u{1}".repeat(20_000);
        let diff = "d".repeat(50_000);
        let log = "q".repeat(60_000);
        let built = build_evidence(&EvidenceInput {
            ticket: &ticket,
            diff: &diff,
            log: &log,
            ..base()
        });
        assert_eq!(
            built.diff_note,
            "changed lines only, no context lines; the diff was cut after its first 2000 characters of 50000"
        );
        assert_eq!(text(&built, "diff"), "d".repeat(2_000));
        assert_eq!(
            built.log_note,
            "the log was trimmed to its last 4000 characters of 60000"
        );
        assert_eq!(built.base_log_chars, 20_000);
    }

    #[test]
    fn takes_the_wider_log_tail_on_the_widening_budget() {
        let raw = format!("{}\n", "w".repeat(50_000));
        let base_built = build_evidence(&EvidenceInput {
            log: &raw,
            ..base()
        });
        let wide_built = build_evidence(&EvidenceInput {
            log: &raw,
            widened: true,
            ..base()
        });
        assert!(js::utf16_len(text(&base_built, "log")) <= 20_000);
        assert!(js::utf16_len(text(&wide_built, "log")) > 20_000);
        // The note names the diff the widening budget actually carries: the base budget is `-U0`
        // changed lines, the widened one has context lines.
        assert_eq!(base_built.diff_note, "changed lines only, no context lines");
        assert_eq!(wide_built.diff_note, "the full diff, with context lines");
        assert_eq!(
            text(&wide_built, "diff_note"),
            "the full diff, with context lines"
        );
    }

    #[test]
    fn counts_a_cut_through_a_surrogate_pair_as_javascript_does() {
        // A Ticket whose 20,000th unit is the high half of an emoji: JavaScript keeps that half and
        // counts it, so the text here drops it and the JSON size still pays the six units of `\udxxx`.
        let ticket = format!("{}\u{1F600}rest", "t".repeat(19_999));
        let cut = head_cut(&ticket, TICKET_CHARS);
        assert_eq!(cut.text, "t".repeat(19_999));
        assert_eq!(cut.js_len, 20_000);
        assert!(cut.lone());
        // A log whose tail starts on the low half of a pair, with no newline to cut forward to.
        let log = format!("\u{1F600}{}", "z".repeat(10));
        let tail = tail_cut(&log, 11);
        assert_eq!(tail.text, "z".repeat(10));
        assert_eq!(tail.js_len, 11);
        // A diff cut at its floor through a pair: the note counts the lone half, as `slice(0, 2000)` did.
        let diff = format!("{}\u{1F600}{}", "d".repeat(1_999), "d".repeat(1_000));
        let built = build_evidence(&EvidenceInput {
            ticket: &"\u{1}".repeat(20_000),
            diff: &diff,
            ..base()
        });
        assert_eq!(text(&built, "diff"), "d".repeat(1_999));
        assert_eq!(
            built.diff_note,
            "changed lines only, no context lines; the diff was cut after its first 2000 characters of 3001"
        );
        assert!(built.diff_trimmed);
    }
}
