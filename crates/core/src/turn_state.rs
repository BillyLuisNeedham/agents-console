//! Turn state (the Conversations ADR, docs/adr/0018-conversations-beside-tickets.md; CONTEXT.md: Turn
//! state), ported from engine/turn-state.ts: a Conversation is always either `working` (its agent is
//! acting, or nobody has looked yet) or `waiting` (on the operator). Detected purely from consecutive
//! pane reads, with no knowledge of herdr, sockets or timers: the Conversation module's tick is the
//! only caller, on a fixed interval, and owns everything about when to read a pane and what to do once
//! the state changes.
//!
//! A pane read is two regions (issue #71): the transcript, and below it the TUI's chrome (the input
//! box and whatever footer the harness draws under it). Only the transcript says anything about the
//! Turn: the footer carries live counters that move while the agent sits idle, and it is what a
//! bottom-up scan for "the last thing said" finds first. So the split is made once, by
//! [`transcript_of`], and both the stability comparison and the last-line extraction work on the
//! transcript alone; the idle pattern is still looked for in the whole read, since every harness's idle
//! marker lives in the chrome.
//!
//! The viewport chrome pattern lives here too: the echo verification of a typed paste (the engine's
//! pane session) strips the same chrome a wrapped line carries.

use std::sync::LazyLock;

use ac_protocol::TurnSide;
use regex::Regex;

use crate::js;

/// "unchanged for 2 reads with the idle pattern present": a single stable-and-idle read is discounted
/// as a boot flicker or a mid-render snapshot, the same reasoning the readiness wait applies to its own
/// consecutive-match rule.
pub const IDLE_STABLE_READS: u32 = 2;

/// How far above the input box's bottom border [`transcript_of`] looks for its top border. An empty
/// input box is one content row on claude and three on opencode; a typed draft grows it a row per
/// line. Past this many rows the box is treated as having no top border in view, so a border row much
/// further up (a rendered table's edge) is never mistaken for it.
pub const INPUT_BOX_MAX_ROWS: usize = 8;

/// What a row break inside a TUI's input box puts between the two halves of a wrapped line: the
/// newline, the padding on both rows, and the box-drawing or block glyphs of the box border
/// (U+2500-U+259F). The TypeScript's `/[\s─-▟]+/g`, `\s` being JavaScript's whitespace.
pub static VIEWPORT_WRAP_CHROME: LazyLock<Regex> = LazyLock::new(|| {
    let whitespace = js::WHITESPACE_CLASS
        .strip_prefix('[')
        .and_then(|class| class.strip_suffix(']'))
        .expect("the whitespace class is one bracket expression");
    Regex::new(&format!("[{whitespace}\u{2500}-\u{259F}]+"))
        .expect("the viewport chrome pattern compiles")
});

/// A Conversation's Turn state, stored whole on its runtime and handed back in on the next read.
/// `state`, `last_line` and `idle_since` are what the wire shows; `stable_reads` and `transcript` are
/// the transition's own memory and never leave the engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnState {
    pub state: TurnSide,
    pub last_line: String,
    /// When the Turn last flipped to `waiting`; `None` while working.
    pub idle_since: Option<String>,
    pub stable_reads: u32,
    pub transcript: String,
}

/// The Turn state of a freshly launched Conversation: working, unstable, nothing said yet.
pub const FRESH_TURN: TurnState = TurnState {
    state: TurnSide::Working,
    last_line: String::new(),
    idle_since: None,
    stable_reads: 0,
    transcript: String::new(),
};

/// One read's transition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnTransition {
    pub turn: TurnState,
    /// Whether `state` or `last_line` moved: the tick's signal to publish a snapshot.
    pub publish: bool,
}

fn is_blank(row: &str) -> bool {
    js::trim(row).is_empty()
}

// A border row: box-drawing and block glyphs only, which is exactly what the chrome pattern strips to
// nothing. A blank row is not a border.
fn is_border(row: &str) -> bool {
    !is_blank(row) && VIEWPORT_WRAP_CHROME.replace_all(row, "").is_empty()
}

/// The transcript region of a pane read: every row above the TUI's input box. The lowest border row
/// in the read is the box's bottom edge, the highest border row within [`INPUT_BOX_MAX_ROWS`] above it
/// is the top edge, and everything above the top edge is transcript. With no border row anywhere the
/// whole read is transcript; with a bottom edge but no other in reach, the bottom edge alone is the
/// split.
pub fn transcript_of(text: &str) -> String {
    let rows: Vec<&str> = text.split('\n').collect();
    let Some(bottom) = rows.iter().rposition(|row| is_border(row)) else {
        return text.to_owned();
    };
    let mut top = bottom;
    for j in (bottom.saturating_sub(INPUT_BOX_MAX_ROWS)..bottom).rev() {
        if is_border(rows[j]) {
            top = j;
        }
    }
    rows[..top].join("\n")
}

// The last row of an already-split transcript that still has content once the chrome runs are
// collapsed: what the operator would read as "the last thing said".
fn last_line_of(transcript: &str) -> String {
    transcript
        .split('\n')
        .rev()
        .map(|line| js::trim(&VIEWPORT_WRAP_CHROME.replace_all(line, " ")).to_owned())
        .find(|stripped| !stripped.is_empty())
        .unwrap_or_default()
}

/// The last content line of a raw pane read's transcript region.
pub fn extract_last_line(text: &str) -> String {
    last_line_of(&transcript_of(text))
}

/// One turn-state read: the current Turn state, one pane read, the harness's idle pattern and the
/// clock, to the next Turn state and whether to publish it. Any change in the transcript region resets
/// the idle count and marks the turn `working`; chrome-only movement is not a change at all. Once the
/// transcript stops changing, [`IDLE_STABLE_READS`] consecutive stable-and-idle reads flip the state to
/// `waiting`, stamping `idle_since` with `now`, and it stays there until the transcript changes again.
/// A stable read without the idle pattern resets the count and holds the current state, so a waiting
/// Conversation does not flap back to working on it.
pub fn next_turn_state(
    current: &TurnState,
    text: &str,
    idle_pattern: &str,
    now: &str,
) -> TurnTransition {
    let transcript = transcript_of(text);
    let last_line = last_line_of(&transcript);
    if transcript != current.transcript {
        let publish =
            current.state != TurnSide::Working || last_line != last_line_of(&current.transcript);
        return TurnTransition {
            turn: TurnState {
                state: TurnSide::Working,
                last_line,
                idle_since: None,
                stable_reads: 0,
                transcript,
            },
            publish,
        };
    }
    let idle = !idle_pattern.is_empty() && text.contains(idle_pattern);
    let stable_reads = if idle { current.stable_reads + 1 } else { 0 };
    let state = if idle && stable_reads >= IDLE_STABLE_READS {
        TurnSide::Waiting
    } else {
        current.state
    };
    let idle_since = if state == TurnSide::Waiting {
        if current.state == TurnSide::Waiting {
            current.idle_since.clone()
        } else {
            Some(now.to_owned())
        }
    } else {
        None
    };
    TurnTransition {
        publish: state != current.state,
        turn: TurnState {
            state,
            last_line,
            idle_since,
            stable_reads,
            transcript,
        },
    }
}

#[cfg(test)]
mod tests {
    //! engine/turn-state.test.ts.

    use super::*;

    const T0: &str = "2026-09-13T10:00:00.000Z";
    const T1: &str = "2026-09-13T10:00:02.000Z";

    fn held(
        transcript: &str,
        state: TurnSide,
        stable_reads: u32,
        idle_since: Option<&str>,
    ) -> TurnState {
        TurnState {
            state,
            last_line: extract_last_line(transcript),
            idle_since: idle_since
                .map(str::to_owned)
                .or_else(|| (state == TurnSide::Waiting).then(|| T0.to_owned())),
            stable_reads,
            transcript: transcript.to_owned(),
        }
    }

    #[test]
    fn starts_working_on_the_very_first_read() {
        let r = next_turn_state(&FRESH_TURN, "some pane text\n❯", "❯", T1);
        assert_eq!(r.turn.state, TurnSide::Working);
        assert_eq!(r.turn.idle_since, None);
        assert!(r.publish);
    }

    #[test]
    fn a_text_change_resets_to_working() {
        let r = next_turn_state(&held("old", TurnSide::Waiting, 5, None), "new", "❯", T1);
        assert_eq!(r.turn.state, TurnSide::Working);
        assert_eq!(r.turn.stable_reads, 0);
        assert_eq!(r.turn.idle_since, None);
        assert!(r.publish);
    }

    #[test]
    fn working_to_working_publishes_only_when_the_last_line_moved() {
        let r1 = next_turn_state(
            &held("line one\nline two", TurnSide::Working, 0, None),
            "line one\nline two more",
            "❯",
            T1,
        );
        assert_eq!(r1.turn.state, TurnSide::Working);
        assert!(r1.publish);
        let r2 = next_turn_state(
            &held("same tail\nfoo", TurnSide::Working, 0, None),
            "other tail\nfoo",
            "❯",
            T1,
        );
        assert_eq!(r2.turn.last_line, "foo");
        assert!(!r2.publish);
    }

    #[test]
    fn needs_two_stable_idle_reads_to_flip_to_waiting() {
        assert_eq!(IDLE_STABLE_READS, 2);
        let mut r = next_turn_state(&FRESH_TURN, "agent output\n❯", "❯", T0);
        assert_eq!(r.turn.state, TurnSide::Working);
        r = next_turn_state(&r.turn, "agent output\n❯", "❯", T0);
        assert_eq!(r.turn.state, TurnSide::Working);
        assert_eq!(r.turn.stable_reads, 1);
        assert_eq!(r.turn.idle_since, None);
        assert!(!r.publish);
        r = next_turn_state(&r.turn, "agent output\n❯", "❯", T1);
        assert_eq!(r.turn.state, TurnSide::Waiting);
        assert_eq!(r.turn.idle_since.as_deref(), Some(T1));
        assert!(r.publish);
    }

    #[test]
    fn a_stable_read_without_the_idle_pattern_resets_the_count() {
        let r = next_turn_state(
            &held("mid dialog", TurnSide::Working, 1, None),
            "mid dialog",
            "❯",
            T1,
        );
        assert_eq!(r.turn.state, TurnSide::Working);
        assert_eq!(r.turn.stable_reads, 0);
        assert_eq!(r.turn.idle_since, None);
        assert!(!r.publish);
    }

    #[test]
    fn once_waiting_stable_idle_reads_hold_and_keep_idle_since() {
        let r = next_turn_state(&held("❯", TurnSide::Waiting, 2, Some(T0)), "❯", "❯", T1);
        assert_eq!(r.turn.state, TurnSide::Waiting);
        assert_eq!(r.turn.idle_since.as_deref(), Some(T0));
        assert!(!r.publish);
        assert_eq!(r.turn.stable_reads, 3);
    }

    #[test]
    fn once_waiting_a_stable_read_without_the_pattern_does_not_flap() {
        let r = next_turn_state(&held("❯", TurnSide::Waiting, 2, Some(T0)), "❯", "zzz", T1);
        assert_eq!(r.turn.state, TurnSide::Waiting);
        assert_eq!(r.turn.idle_since.as_deref(), Some(T0));
        assert_eq!(r.turn.stable_reads, 0);
        assert!(!r.publish);
    }

    #[test]
    fn an_empty_idle_pattern_never_matches() {
        let r = next_turn_state(&held("x", TurnSide::Working, 5, None), "x", "", T1);
        assert_eq!(r.turn.state, TurnSide::Working);
        assert_eq!(r.turn.stable_reads, 0);
    }

    #[test]
    fn extract_last_line_basics() {
        assert_eq!(extract_last_line("first\nsecond\nthird   "), "third");
        assert_eq!(extract_last_line("hello\n\n\n   \n"), "hello");
        assert_eq!(
            extract_last_line("agent said this\n──────────\n│          │\n──────────"),
            "agent said this"
        );
        assert_eq!(extract_last_line("   \n──────\n\n"), "");
        assert_eq!(extract_last_line(""), "");
        assert_eq!(extract_last_line("some─────text"), "some text");
    }

    fn rule() -> String {
        "─".repeat(120)
    }

    fn pane(rows: &[String], height: usize) -> String {
        let mut all = rows.to_vec();
        while all.len() < height {
            all.push(String::new());
        }
        all.join("\n")
    }

    fn rows(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    fn claude_header() -> Vec<String> {
        rows(&[
            " ▐▛███▛█   Claude Code v2.1.267",
            "▝▜██████▀  Haiku 4.5 · Claude Max",
            "  ▝▝ ▝▝    /tmp/tmp.dH29nBRnvR",
            "",
            "",
        ])
    }

    fn pad_end(text: &str, width: usize) -> String {
        let count = text.encode_utf16().count();
        format!("{text}{}", " ".repeat(width.saturating_sub(count)))
    }

    fn claude_footer(statusline: &str) -> Vec<String> {
        vec![
            pad_end(&format!("  [/tmp/tmp.dH29nBRnvR ] {statusline}"), 76)
                + "Update available! Run: mise upgrade claude",
            "  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"
                .to_owned()
                + &" ".repeat(40)
                + "/rc",
        ]
    }

    fn claude_boot() -> String {
        let mut all = claude_header();
        all.extend(["".to_owned(), rule(), "❯ ".to_owned(), rule()]);
        all.extend(claude_footer(""));
        pane(&all, 40)
    }

    fn claude_working() -> String {
        let mut all = claude_header();
        all.extend(rows(&[
            "❯ reply with exactly the word hello and nothing else",
            "",
            "✢ Sautéing…",
            "",
        ]));
        all.extend([rule(), "❯ ".to_owned(), rule()]);
        all.extend(claude_footer(""));
        pane(&all, 40)
    }

    fn claude_idle(statusline: &str) -> String {
        let mut all = claude_header();
        all.extend(rows(&[
            "❯ reply with exactly the word hello and nothing else",
            "",
            "● hello",
            "",
            "✻ Sautéed for 1s · done 2:35 PM",
            "",
        ]));
        all.extend([rule(), "❯ ".to_owned(), rule()]);
        all.extend(claude_footer(statusline));
        pane(&all, 40)
    }

    fn opencode_idle() -> String {
        let mut all = vec![String::new(); 13];
        all.extend(rows(&[
            "                                                                          ▄",
            "                                         █▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█",
            "                                         █  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀",
            "                                         ▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀",
            "",
            "",
            "                       ┃",
            "                       ┃  Ask anything… \"What is the tech stack of this project?\"",
            "                       ┃",
            "                       ┃  Build · Kimi K3 (1M) Kimi For Coding (OAuth) · high",
        ]));
        all.push(format!("                       ╹{}", "▀".repeat(72)));
        all.push(
            "                                                                       tab agents  ctrl+p commands"
                .to_owned(),
        );
        all.extend(vec![String::new(); 13]);
        all.push(format!("  /tmp/tmp.dH29nBRnvR{}1.18.29", " ".repeat(90)));
        pane(&all, 40)
    }

    #[test]
    fn transcript_of_cuts_claude_at_the_input_box_top_rule() {
        let transcript = transcript_of(&claude_idle("63.5k 32% $0.07"));
        let lines: Vec<&str> = transcript.split('\n').collect();
        assert_eq!(lines[lines.len() - 2], "✻ Sautéed for 1s · done 2:35 PM");
        assert!(!transcript.contains("❯ \n"));
        assert!(!transcript.contains("-- INSERT --"));
        assert!(!transcript.contains("63.5k"));
        assert!(transcript.contains("❯ reply with exactly the word hello"));
    }

    #[test]
    fn transcript_of_cuts_opencode_at_the_padding_row() {
        let transcript = transcript_of(&opencode_idle());
        assert!(!transcript.contains("Ask anything"));
        assert!(!transcript.contains("ctrl+p commands"));
        assert!(!transcript.contains("1.18.29"));
        assert!(transcript.contains("█▀▀█"));
    }

    #[test]
    fn transcript_of_without_a_border_is_the_whole_read() {
        assert_eq!(
            transcript_of("agent said this\n\n\n"),
            "agent said this\n\n\n"
        );
        assert_eq!(transcript_of(""), "");
    }

    #[test]
    fn transcript_of_splits_at_the_bottom_border_alone_when_none_is_in_reach() {
        let mut all = rows(&["┌────┐", "│ a  │", "└────┘"]);
        all.extend(vec!["draft line".to_owned(); INPUT_BOX_MAX_ROWS + 1]);
        all.extend([rule(), "footer".to_owned()]);
        let transcript = transcript_of(&all.join("\n"));
        assert_eq!(
            transcript.split('\n').collect::<Vec<_>>(),
            all[..all.len() - 2]
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn transcript_of_takes_a_top_border_exactly_at_the_reach() {
        let mut all = vec!["said".to_owned(), rule()];
        all.extend(vec!["draft".to_owned(); INPUT_BOX_MAX_ROWS - 1]);
        all.extend([rule(), "footer".to_owned()]);
        assert_eq!(transcript_of(&all.join("\n")), "said");
    }

    #[test]
    fn transcript_of_takes_the_highest_border_row_in_reach() {
        let all = ["said", "┃", "┃ typed", "┃", "┃ model", "╹▀▀▀▀", "footer"];
        assert_eq!(transcript_of(&all.join("\n")), "said");
    }

    #[test]
    fn extract_last_line_on_live_frames() {
        assert_eq!(
            extract_last_line(&claude_idle("63.5k 32% $0.07")),
            "✻ Sautéed for 1s · done 2:35 PM"
        );
        assert_eq!(extract_last_line(&claude_working()), "✢ Sautéing…");
        assert_eq!(extract_last_line(&claude_boot()), "/tmp/tmp.dH29nBRnvR");
        assert_eq!(extract_last_line(&opencode_idle()), "");
        assert_eq!(extract_last_line("│ a │ b │\n└───┴───┘"), "a b");
    }

    #[test]
    fn reaches_waiting_on_an_idle_claude_frame_ignoring_the_statusline() {
        let mut r = next_turn_state(&FRESH_TURN, &claude_idle("63.5k 32% $0.07"), "❯", T0);
        assert_eq!(r.turn.state, TurnSide::Working);
        assert_eq!(r.turn.last_line, "✻ Sautéed for 1s · done 2:35 PM");
        r = next_turn_state(&r.turn, &claude_idle("63.6k 32% $0.08"), "❯", T0);
        assert_eq!(r.turn.state, TurnSide::Working);
        assert_eq!(r.turn.stable_reads, 1);
        r = next_turn_state(&r.turn, &claude_idle("63.6k 32% $0.08 ↻ 33m"), "❯", T1);
        assert_eq!(r.turn.state, TurnSide::Waiting);
        assert_eq!(r.turn.idle_since.as_deref(), Some(T1));
        assert!(r.publish);
        r = next_turn_state(
            &r.turn,
            &claude_idle("63.6k 32% $0.08 ↻ 32m"),
            "❯",
            "2026-09-13T10:00:04.000Z",
        );
        assert_eq!(r.turn.state, TurnSide::Waiting);
        assert_eq!(r.turn.idle_since.as_deref(), Some(T1));
        assert!(!r.publish);
        assert_eq!(r.turn.stable_reads, 3);
    }

    #[test]
    fn goes_back_to_working_when_the_transcript_moves() {
        let r = next_turn_state(
            &held(
                &transcript_of(&claude_idle("63.5k 32% $0.07")),
                TurnSide::Waiting,
                4,
                None,
            ),
            &claude_working(),
            "❯",
            T1,
        );
        assert_eq!(r.turn.state, TurnSide::Working);
        assert_eq!(r.turn.stable_reads, 0);
        assert_eq!(r.turn.idle_since, None);
        assert_eq!(r.turn.last_line, "✢ Sautéing…");
        assert!(r.publish);
    }

    #[test]
    fn carries_the_transcript_it_judged() {
        let first = next_turn_state(&FRESH_TURN, &claude_idle("63.5k 32% $0.07"), "❯", T0);
        assert_eq!(
            first.turn.transcript,
            transcript_of(&claude_idle("63.5k 32% $0.07"))
        );
        let second = next_turn_state(&first.turn, &claude_idle("63.5k 32% $0.07"), "❯", T1);
        assert_eq!(second.turn.stable_reads, 1);
    }

    #[test]
    fn the_chrome_pattern_takes_javascript_whitespace_and_the_box_glyphs() {
        assert_eq!(
            VIEWPORT_WRAP_CHROME.replace_all("a \u{a0}\u{feff}─▟b", ""),
            "ab"
        );
        assert_eq!(VIEWPORT_WRAP_CHROME.replace_all("a■b", ""), "a■b");
    }
}
